import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNpmReleaseInputs } from './resolve-npm-release-inputs.mjs';

test('resolveNpmReleaseInputs gives preview releases their sole permitted source and dist-tag', () => {
  assert.deepEqual(
    resolveNpmReleaseInputs({
      channel: 'preview',
      npmTag: 'next',
      sourceRef: 'auto',
      publishCli: true,
      publishStack: false,
      publishServer: false,
      publishPluginSdk: false,
      publishSdk: false,
    }),
    { channel: 'preview', npmTag: 'next', sourceRef: 'preview' },
  );
});

test('resolveNpmReleaseInputs rejects a mismatched tag, source, or empty publication request', () => {
  const valid = {
    channel: 'production',
    npmTag: 'latest',
    sourceRef: 'auto',
    publishCli: true,
    publishStack: false,
    publishServer: false,
    publishPluginSdk: false,
    publishSdk: false,
  };

  assert.throws(
    () => resolveNpmReleaseInputs({ ...valid, npmTag: 'next' }),
    /npm_tag must be 'latest'/,
  );
  assert.throws(
    () => resolveNpmReleaseInputs({ ...valid, sourceRef: 'preview' }),
    /Production releases must run from main/,
  );
  assert.throws(
    () => resolveNpmReleaseInputs({ ...valid, publishCli: false }),
    /At least one/,
  );
});

test('resolveNpmReleaseInputs refuses workflow dispatch from an untrusted control ref', () => {
  assert.throws(
    () =>
      resolveNpmReleaseInputs({
        channel: 'preview',
        npmTag: 'next',
        sourceRef: 'auto',
        publishCli: true,
        publishStack: false,
        publishServer: false,
        publishPluginSdk: false,
        publishSdk: false,
        eventName: 'workflow_dispatch',
        refName: 'feature/untrusted',
      }),
    /Refusing workflow_dispatch from untrusted ref/,
  );
});
