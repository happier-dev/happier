import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

describe('Antigravity plugin manifest', () => {
  it('round-trips through canonical Plugin Manifest v2 ingestion', () => {
    const objectIngestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const jsonIngestion = ingestPluginManifestV2(JSON.parse(JSON.stringify(PLUGIN_MANIFEST)));

    expect(objectIngestion).toMatchObject({ ok: true });
    expect(jsonIngestion).toEqual(objectIngestion);
  });

  it('declares one canonical custom agent while runtime implementation stays daemon-owned', () => {
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.agent.antigravity',
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: {
        required: expect.arrayContaining([expect.objectContaining({
          id: 'antigravity-external-session-transcripts',
          capability: 'filesystem',
          scope: {
            locations: [{ root: 'workspace' }],
            access: ['read'],
          },
        }), expect.objectContaining({
          id: 'localharness-process',
          capability: 'process',
        }), expect.objectContaining({
          id: 'antigravity-cli-process',
          capability: 'process',
        })]),
        optional: [],
      },
    });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'antigravity',
        title: 'Antigravity',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: expect.objectContaining({
          surfaces: ['terminal', 'externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: {
              writerSafety: 'unsupported',
            },
            sources: [{
              sourceKind: 'antigravityCliPrint',
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'antigravityCliPrint' },
                  { kind: 'string', name: 'brainDir', min: 1, max: 10_000, nullish: true },
                ],
                passthrough: true,
              },
              key: {
                segments: [
                  { kind: 'literal', value: 'antigravityCliPrint' },
                  { kind: 'field', field: 'brainDir' },
                ],
              },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      }),
    ]);
  });

  it('declares canonical localharness dependency and hook identities', () => {
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toEqual([
      expect.objectContaining({
        id: 'localharness',
        executable: 'localharness',
        platforms: ['macos', 'linux', 'windows'],
        sources: [expect.objectContaining({
          kind: 'managedPypiWheelAsset',
          installId: 'dep.antigravity.localharness',
          distribution: 'google-antigravity',
          versionSpecifier: '>=0.1.4,<0.2.0',
        })],
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('agentSettings');
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({
        id: 'resolve-prerequisites',
        on: 'agent.resolvePrerequisites',
        filters: { agentId: 'antigravity' },
        executionKind: 'decide',
      }),
    ]);
  });
});
