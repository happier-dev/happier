import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNpmReleaseMetadata } from './resolve-release-metadata.mjs';

test('resolveNpmReleaseMetadata returns only requested package versions and source identity', () => {
  assert.deepEqual(
    resolveNpmReleaseMetadata({
      channel: 'preview',
      sourceRef: 'preview',
      sha: 'a'.repeat(40),
      npmTag: 'next',
      versions: {
        cli: '1.2.3-preview.7',
        stack: '4.5.6-preview.7',
        server: '7.8.9-preview.7',
      },
      requested: { cli: true, stack: false, server: true, pluginSdk: false, sdk: false },
    }),
    {
      sha: 'a'.repeat(40),
      sourceRef: 'preview',
      channel: 'preview',
      npmTag: 'next',
      versions: { cli: '1.2.3-preview.7', server: '7.8.9-preview.7' },
    },
  );
});

test('resolveNpmReleaseMetadata emits the requested Channels protocol version', () => {
  assert.deepEqual(
    resolveNpmReleaseMetadata({
      channel: 'preview',
      sourceRef: 'preview',
      sha: 'b'.repeat(40),
      npmTag: 'next',
      versions: { cli: '1.2.3-preview.7', channelsProtocol: '0.1.0-preview.7' },
      requested: {
        cli: false,
        stack: false,
        server: false,
        pluginSdk: false,
        sdk: false,
        channelsProtocol: true,
      },
    }),
    {
      sha: 'b'.repeat(40),
      sourceRef: 'preview',
      channel: 'preview',
      npmTag: 'next',
      versions: { channelsProtocol: '0.1.0-preview.7' },
    },
  );
});

test('resolveNpmReleaseMetadata rejects a version that could forge a GitHub output', () => {
  assert.throws(
    () =>
      resolveNpmReleaseMetadata({
        channel: 'preview',
        sourceRef: 'preview',
        sha: 'a'.repeat(40),
        npmTag: 'next',
        versions: { cli: '1.2.3-preview.7\nsha=attacker-controlled' },
        requested: { cli: true, stack: false, server: false, pluginSdk: false, sdk: false },
      }),
    /rejected non-canonical cli version/,
  );
});
