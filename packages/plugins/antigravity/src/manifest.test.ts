import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

const officialAssets = [
  ['darwin', 'arm64', 'macos', 'darwin-arm64', '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88', 111_456_962, 278_535_456, 397_146_848],
  ['darwin', 'x64', 'macos', 'darwin-x86_64', 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646', 117_245_544, 282_840_688, 407_016_080],
  ['linux', 'x64', 'linux', 'linux-x86_64', '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96', 333_727_150, 926_533_965, 1_056_922_005],
  ['linux', 'arm64', 'linux', 'linux-arm64', '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf', 321_690_363, 930_848_992, 1_054_073_960],
  ['win32', 'x64', 'windows', 'windows-x86_64', '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9', 124_509_787, 145_548_952, 226_986_288],
  ['win32', 'arm64', 'windows', 'windows-arm64', '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3', 124_654_803, 135_640_216, 221_533_688],
] as const;

describe('Antigravity plugin manifest', () => {
  it('round-trips through canonical Plugin Manifest v2 ingestion', () => {
    const objectIngestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const jsonIngestion = ingestPluginManifestV2(JSON.parse(JSON.stringify(PLUGIN_MANIFEST)));

    expect(objectIngestion, JSON.stringify(objectIngestion)).toMatchObject({ ok: true });
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
        runtime: expect.objectContaining({ kind: 'acp', transport: expect.objectContaining({
          kind: 'stdio', executable: { kind: 'managedDependency', id: 'agy-acp-server' },
        }) }),
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
            sources: [expect.objectContaining({
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
            })],
          },
        },
      }),
    ]);
  });

  it.each(officialAssets)('publishes the reviewed 1.3.0 %s/%s managed asset', (platform, arch, directory, target, sha256, archiveBytes, maxFileBytes, expandedBytes) => {
    const source = PLUGIN_MANIFEST.contributes.managedDependencies?.[0]?.sources?.[0];
    expect(source).toMatchObject({
      kind: 'pinnedArchive',
      version: '1.3.0',
      assetsByPlatform: {
        [`${platform}-${arch}`]: {
          archiveUrl: `https://dl.google.com/agy-extensions/releases/${directory}/agy-acp-server-1.3.0-${target}.zip`,
          sha256,
          sizeBytes: archiveBytes,
          executableSubpath: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
          ...(platform === 'linux' ? { args: ['--uid='] } : {}),
        },
      },
    });
    if (source?.kind !== 'pinnedArchive') throw new Error('Expected pinned archive');
    expect(source.archiveExtractionLimits?.maxArchiveBytes).toBeGreaterThanOrEqual(archiveBytes);
    expect(source.archiveExtractionLimits?.maxFileBytes).toBeGreaterThanOrEqual(maxFileBytes);
    expect(source.archiveExtractionLimits?.maxExpandedBytes).toBeGreaterThanOrEqual(expandedBytes);
  });

  it('declares the official pinned ACP registry archive without a custom session hook', () => {
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toEqual([
      expect.objectContaining({
        id: 'agy-acp-server',
        executable: 'agy_acp_server',
        platforms: ['macos', 'linux', 'windows'],
        sources: [expect.objectContaining({
          kind: 'pinnedArchive', version: '1.3.0',
          archiveExtractionLimits: {
            maxArchiveBytes: 1024 * 1024 * 1024,
            maxFileBytes: 2 * 1024 * 1024 * 1024,
            maxExpandedBytes: 2 * 1024 * 1024 * 1024,
            timeoutMs: 10 * 60_000,
          },
          assetsByPlatform: expect.objectContaining({ 'linux-x64': expect.objectContaining({ args: ['--uid='], sizeBytes: 333727150 }) }),
        })],
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('agentSettings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('settings');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
  });
});
