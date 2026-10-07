import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Antigravity plugin manifest', () => {
  it('round-trips through canonical Plugin Manifest v2 ingestion', () => {
    const objectIngestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const jsonIngestion = ingestPluginManifestV2(JSON.parse(JSON.stringify(PLUGIN_MANIFEST)));

    expect(objectIngestion).toMatchObject({ ok: true });
    expect(jsonIngestion).toEqual(objectIngestion);
  });

  it('declares host-owned ACP as the sole Antigravity session runtime', () => {
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.agent.antigravity',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: {
        required: expect.arrayContaining([expect.objectContaining({
          id: 'antigravity-external-session-transcripts',
          capability: 'filesystem',
          scope: {
            locations: [{ root: 'workspace' }],
            access: ['read'],
          },
        }), expect.objectContaining({
          id: 'antigravity-acp-process',
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
        runtime: expect.objectContaining({ kind: 'acp', transport: {
          kind: 'stdio', executable: { kind: 'managedDependency', id: 'agy-acp-server' },
        } }),
        primary: 'sessions',
        connectedAccounts: [{
          purpose: 'model_upstream',
          service: {
            pluginId: 'happier.agent.gemini',
            localId: 'gemini-account',
          },
          required: false,
          materializationKinds: ['environment'],
          credentialKinds: ['token'],
        }],
        capabilities: expect.objectContaining({
          surfaces: ['terminal', 'externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: {
              writerSafety: 'unsupported',
            },
            sources: [{
              sourceKind: 'antigravityCliPrint',
              contentSearch: false,
              schema: {
                fields: [
                  { kind: 'literal', name: 'kind', value: 'antigravityCliPrint' },
                  { kind: 'string', name: 'brainDir', min: 1, max: 10_000, nullish: true },
                  { kind: 'string', name: 'conversationId', min: 1, max: 2_000, nullish: true },
                  { kind: 'string', name: 'sourceRevision', min: 1, max: 10_000, nullish: true },
                ],
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

  it('declares the official pinned ACP registry archive without a custom session hook', () => {
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toEqual([
      expect.objectContaining({
        id: 'agy-acp-server',
        executable: 'agy_acp_server',
        platforms: ['macos', 'linux', 'windows'],
        sources: [expect.objectContaining({
          kind: 'pinnedArchive', version: '1.1.1',
          archiveExtractionLimits: {
            maxArchiveBytes: 1024 * 1024 * 1024,
            maxFileBytes: 2 * 1024 * 1024 * 1024,
            maxExpandedBytes: 2 * 1024 * 1024 * 1024,
            timeoutMs: 10 * 60_000,
          },
          assetsByPlatform: expect.objectContaining({ 'linux-x64': expect.objectContaining({ args: ['--uid='], sizeBytes: 681969407 }) }),
        })],
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('agentSettings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('settings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
  });
});
