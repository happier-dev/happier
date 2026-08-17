import assert from 'node:assert/strict';

let importFailure;
try {
  await import('@happier-dev/plugin-sdk/src/manifest.js');
} catch (error) {
  importFailure = error;
}

assert.equal(
  importFailure?.code,
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'the exact installed SDK tarball must reject its private source subpath through package exports',
);
