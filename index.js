'use strict';
var gutil = require('gulp-util'),
    through = require('through2'),
    useref = require('useref');

module.exports = function (options) {
    var opts = options || {},
        path = require('path'),
        concat = require('gulp-concat'),
        gulpif = require('gulp-if'),
        es = require('event-stream'),
        types = opts.types || [ 'css', 'js' ],
        isRelativeUrl = require('is-relative-url'),
        vfs = require('vinyl-fs'),
        transforms = Array.prototype.slice.call(arguments, 1),
        unprocessed = 0,
        end = false,
        additionalFiles = [],
        waitForAssets,
        searchPath = opts.searchPath;

    if (searchPath && Array.isArray(searchPath)) {
        searchPath = '{' + searchPath.join(',') + '}';
    }

    // If any external streams were included, add matched files to src
    if (opts.additionalStreams) {
        if (!Array.isArray(opts.additionalStreams)) {
            opts.additionalStreams = [ opts.additionalStreams ];
        }

        opts.additionalStreams = opts.additionalStreams.map(function (stream) {
            // filters stream to select needed files
            return stream
                .pipe(es.through(function (file) {
                    additionalFiles.push(file);
                }));
        });
    }

    if (opts.additionalStreams) {
        // If we have additional streams, wait for them to run before continuing
        waitForAssets = es.merge(opts.additionalStreams).pipe(through.obj());
    } else {
        // Else, create a fake stream
        waitForAssets = through.obj();
        waitForAssets.emit('finish');
    }

    return through.obj(function (file, enc, cb) {
        var self = this;

        waitForAssets.pipe(es.wait(function () {
            var output,
                html,
                assets,

                // Cache the file base path relative to the cwd
                // Use later when it could be dropped
                _basePath = path.dirname(file.path);

            if (file.isNull()) {
                cb(null, file);
                return;
            }

            if (file.isStream()) {
                cb(new gutil.PluginError('gulp-useref', 'Streaming not supported'));
                return;
            }

            output = useref(file.contents.toString(), opts);
            html = output[0];

            try {
                file.contents = new Buffer(html);
                self.push(file);
            } catch (err) {
                self.emit('error', new gutil.PluginError('gulp-useref', err));
            }

            if (opts.noAssets) {
                cb();
                return;
            }

            assets = output[1];

            types.forEach(function (type) {
                var files = assets[type];

                if (!files) {
                    return;
                }

                Object.keys(files).forEach(function (name) {
                    var src,
                        globs,
                        filepaths = files[name].assets,
                        sortIndex = {},
                        i = 0,
                        sortedFiles = [],
                        unsortedFiles = [];

                    if (!filepaths.length) {
                        return;
                    }

                    unprocessed++;

                    // Get relative file paths and join with search paths to send to vinyl-fs
                    globs = filepaths
                        .filter(isRelativeUrl)
                        .map(function (filepath) {
                            var searchPaths,
                                pattern,
                                matches,
                                glob = require('glob');

                            if (files[name].searchPaths || searchPath) {
                                searchPaths = path.resolve(file.cwd, files[name].searchPaths || searchPath);
                            }

                            pattern = (searchPaths || _basePath) + path.sep + filepath;

                            matches = glob.sync(pattern, { nosort: true });

                            if (!matches.length) {
                                matches.push(pattern);
                            }

                            if (opts.transformPath) {
                                matches[0] = opts.transformPath(matches[0]);
                            }

                            return matches[0];
                        });

                    src = vfs.src(globs, {
                        base: _basePath,
                        nosort: true
                    });

                    src.on('error', function (err) {
                        self.emit('error', new Error(err));
                    });

                    // add files from external streams
                    additionalFiles.forEach(function (addFile) {
                        src.push(addFile);
                    });

                    // if we added additional files, reorder the stream
                    if (additionalFiles.length > 0) {
                        // Create a sort index so we don't iterate over the globs for every file
                        globs.forEach(function (filename) {
                            sortIndex[filename] = i++;
                        });

                        src = src.pipe(through.obj(function (srcFile, encoding, callback) {
                            var index = sortIndex[srcFile.path];

                            if (index === undefined) {
                                unsortedFiles.push(srcFile);
                            } else {
                                sortedFiles[index] = srcFile;
                            }
                            callback();
                        }, function (callback) {
                            sortedFiles.forEach(function (sorted) {
                                if (sorted !== undefined) {
                                    this.push(sorted);
                                }
                            }, this);

                            unsortedFiles.forEach(function (unsorted) {
                                this.push(unsorted);
                            }, this);
                            callback();
                        }));
                    }

                    // If any external transforms were included, pipe all files to them first
                    transforms.forEach(function (fn) {
                        src = src.pipe(
                            fn(name)
                                .on('error', function () {
                                  this.emit('end');
                                })
                        );
                    });

                    // Add assets to the stream
                    // If noconcat option is false, concat the files first.
                    src
                        .pipe(gulpif(!opts.noconcat, concat(name)))
                        .pipe(through.obj(function (newFile, encoding, callback) {
                            // specify an output path relative to the cwd
                            if (opts.base) {
                                newFile.path = path.join(opts.base, name);
                            }

                            // add file to the asset stream
                            self.push(newFile);
                            callback();
                        }))
                        .on('finish', function () {
                            if (--unprocessed === 0 && end) {
                                // end the asset stream
                                self.emit('end');
                            }
                        });

                });
            });

            cb();
        }));
    }, function () {
        end = true;
        if (unprocessed === 0) {
            this.emit('end');
        }
    });
};
