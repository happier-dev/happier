import assert from 'node:assert/strict';

let importFailure;
try {
  await import('@happier-dev/plugin-ui/testing/rnwSemanticAdapter.js');
} catch (error) {
  importFailure = error;
}

assert.equal(
  importFailure?.code,
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'the exact installed plugin-ui tarball must reject a private semantic-adapter subpath through package exports',
);
