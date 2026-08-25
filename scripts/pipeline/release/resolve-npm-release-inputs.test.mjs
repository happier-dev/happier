import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNpmReleaseInputs } from './resolve-npm-release-inputs.mjs';

test('resolveNpmReleaseInputs gives preview releases their sole permitted source and dist-tag', () => {
  assert.deepEqual(
    resolveNpmReleaseInputs({
      channel: 'preview',
      npmTag: 'next',
      sourceRef: 'auto',
      authorizedSha: 'a'.repeat(40),
      publishCli: true,
      publishStack: false,
      publishServer: false,
      publishPluginSdk: false,
      publishSdk: false,
    }),
    {
      channel: 'preview',
      npmTag: 'next',
      sourceRef: 'preview',
      authorizedSha: 'a'.repeat(40),
    },
  );
});

test('resolveNpmReleaseInputs admits a Channels-protocol-only publication request', () => {
    // The Channels protocol is a publication target in its own right: an
    // operator can select it without also publishing the CLI or an SDK, and
    // the at-least-one-target contract must count it.
    assert.deepEqual(
        resolveNpmReleaseInputs({
            channel: 'preview',
            npmTag: 'next',
            sourceRef: 'auto',
            authorizedSha: 'd'.repeat(40),
            publishCli: false,
            publishStack: false,
            publishServer: false,
            publishPluginSdk: false,
            publishSdk: false,
            publishChannelsProtocol: true,
        }),
        {
            channel: 'preview',
            npmTag: 'next',
            sourceRef: 'preview',
            authorizedSha: 'd'.repeat(40),
        },
    );
});

test('resolveNpmReleaseInputs rejects a mismatched tag, source, or empty publication request', () => {
  const valid = {
    channel: 'production',
    npmTag: 'latest',
    sourceRef: 'auto',
    authorizedSha: 'b'.repeat(40),
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

test('resolveNpmReleaseInputs requires an exact caller-authorized candidate SHA', () => {
  const valid = {
    channel: 'preview',
    npmTag: 'next',
    sourceRef: 'auto',
    authorizedSha: 'c'.repeat(40),
    publishCli: true,
    publishStack: false,
    publishServer: false,
    publishPluginSdk: false,
    publishSdk: false,
  };

  assert.throws(
    () => resolveNpmReleaseInputs({ ...valid, authorizedSha: '' }),
    /authorized_sha must be exactly 40 lowercase hexadecimal characters/,
  );
  assert.throws(
    () => resolveNpmReleaseInputs({ ...valid, authorizedSha: 'C'.repeat(40) }),
    /authorized_sha must be exactly 40 lowercase hexadecimal characters/,
  );
});
