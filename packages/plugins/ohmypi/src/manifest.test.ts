import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function readPackageJson(): Readonly<{
  happier?: Readonly<{
    pluginScaffold?: Readonly<{
      shipping?: unknown;
    }>;
  }>;
}> {
  const url = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ReturnType<typeof readPackageJson>;
}

function requireOhMyPiBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'ohMyPi');
  if (!backend) {
    throw new Error('Expected OhMyPi plugin manifest to declare ohMyPi backend contribution');
  }
  return backend;
}

describe('OhMyPi plugin manifest', () => {
  it('is visible to bundled plugin projection instead of remaining reservation-only', () => {
    const packageJson = readPackageJson();

    expect(packageJson.happier?.pluginScaffold?.shipping).not.toBe('reservation_only');
  });

  it('declares external-session surface handlers for the E.9 file-follow consumer slice', () => {
    const backend = requireOhMyPiBackend();

    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'ohMyPi',
      agentId: 'ohMyPi',
      engine: { kind: 'custom' },
      capabilities: {
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
    expect(backend.surfaceHandlers?.map((handler) => [handler.kind, handler.operation])).toEqual([
      ['externalSession', 'resolveSource'],
      ['externalSession', 'listCandidates'],
      ['externalSession', 'getActivity'],
      ['externalSession', 'pageTranscript'],
      ['externalSession', 'readAfterTranscript'],
      ['externalSession', 'resolveFollowTranscriptPath'],
      ['externalSession', 'acquireFollowLease'],
      ['externalSession', 'resolveLinkIdentity'],
      ['externalSession', 'resolveLinkedIdentity'],
      ['externalSession', 'resolveTakeoverLaunch'],
    ]);
  });
});
