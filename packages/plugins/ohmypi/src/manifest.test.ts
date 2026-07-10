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
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'ohMyPi');
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
      runtime: { kind: 'custom' },
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
      ['terminalRuntime', 'resolveTranscriptBinding'],
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

  it('declares the OhMyPi external-session source schema and source-key rules in the backend manifest surface', () => {
    expect(requireOhMyPiBackend().surfaces?.externalSession?.sources).toEqual([
      {
        sourceKind: 'ohMyPiAgentDir',
        schema: {
          passthrough: true,
          fields: [
            { name: 'kind', kind: 'literal', value: 'ohMyPiAgentDir' },
            { name: 'agentDir', kind: 'string', min: 1, max: 10_000, nullish: true },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'ohMyPiAgentDir' },
            { kind: 'field', field: 'agentDir' },
          ],
        },
      },
    ]);
  });

  it('declares a provider-owned daemon spawn prerequisite hook', () => {
    expect(PLUGIN_MANIFEST.contributes?.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        filters: { agentId: 'ohMyPi' },
        executionKind: 'decide',
        handler: {
          target: 'plugin',
          exportName: 'resolveOhMyPiDaemonSpawnPrerequisites',
        },
      }),
    ]));
  });
});
