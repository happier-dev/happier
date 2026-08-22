import { describe, expect, it } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
} from '@happier-dev/protocol';
import { derivePluginInstallReviewPrincipalDigest } from '../../daemon/installReviewPrincipal';
import { createRegistryInstallReviewPrincipalReader } from './registryInstallReviewPrincipalReader';

describe('registry install-review principal reader', () => {
  it('reads the current installed principal atomically and fails closed when it is absent', async () => {
    const presentation = PluginInstallReviewPrincipalPresentationV1Schema.parse({
      v: 1,
      packageIdentity: { pluginId: 'acme.voice', packageName: '@acme/voice' },
      distributionIdentity: {
        kind: 'npm',
        packageName: '@acme/voice',
        registryOrigin: 'https://registry.npmjs.org',
      },
      publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
      packageSignature: { status: 'verified', keyId: 'acme-key' },
    });
    const principal = derivePluginInstallReviewPrincipalDigest(presentation);
    let principals: Readonly<Record<string, typeof principal>> = { 'acme.voice': principal };
    let presentations: Readonly<Record<string, typeof presentation>> = { 'acme.voice': presentation };
    const reader = createRegistryInstallReviewPrincipalReader({
      snapshotReader: {
        readSnapshot: async () => ({
          installReviewPrincipalDigestsByPluginId: principals,
          installReviewPrincipalPresentationsByPluginId: presentations,
        }),
      },
    });
    const signal = new AbortController().signal;

    await expect(reader.readCurrent({ pluginId: 'acme.voice', signal })).resolves.toEqual({
      digest: principal,
      presentation,
    });
    presentations = {};
    await expect(reader.readCurrent({ pluginId: 'acme.voice', signal })).resolves.toEqual({
      digest: principal,
      presentation: null,
    });
    presentations = { 'acme.voice': presentation };
    principals = {
      'acme.voice': PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    };
    await expect(reader.readCurrent({ pluginId: 'acme.voice', signal })).resolves.toEqual({
      digest: principals['acme.voice'],
      presentation: null,
    });
    principals = {};
    await expect(reader.readCurrent({ pluginId: 'acme.voice', signal })).resolves.toBeNull();
  });
});
