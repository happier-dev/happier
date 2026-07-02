import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { executionRunsCapability } from './toolExecutionRuns';
import type { DetectCliSnapshot } from '../snapshots/cliSnapshot';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { withTempDir } from '../../testkit/fs/tempDir';
import { ExecutionRunIntentSchema, normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';
import * as engineRegistry from '../../agent/runtime/registry/engineRegistry';

function makeCliSnapshot(overrides: Partial<DetectCliSnapshot['clis']>, path = ''): DetectCliSnapshot {
  return {
    path,
    clis: {
      ...(overrides as DetectCliSnapshot['clis']),
    },
    tmux: { available: false },
    windowsTerminal: { available: false },
  };
}

function makeCliEngineRegistryMock(
  contributions: Partial<Awaited<ReturnType<typeof engineRegistry.resolveCliEngineRegistry>>['contributions']>,
): Awaited<ReturnType<typeof engineRegistry.resolveCliEngineRegistry>> {
  return {
    contributions: {
      providers: Object.freeze([]),
      backends: Object.freeze([]),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiDescriptors: Object.freeze([]),
      executionRunProfiles: Object.freeze([]),
      activationTargets: Object.freeze([]),
      hookRegistrations: Object.freeze([]),
      surfaceHandlersByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map(),
      backendDefinitionsById: new Map(),
      executionRunProfilesById: new Map(),
      pluginDiagnosticsByPluginId: {},
      ...contributions,
    },
    resolveForBackendId: async () => null,
    resolveExecutionSurfaces: async () => ({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    }),
  };
}

describe('executionRunsCapability', () => {
  const envScope = createEnvKeyScope(['PATH', 'HAPPIER_CODERABBIT_REVIEW_CMD', 'HAPPIER_CODEX_BACKEND_MODE']);

  beforeEach(() => {
    envScope.restore();
    envScope.patch({
      HAPPIER_CODEX_BACKEND_MODE: undefined,
    });
  });

  afterEach(() => {
    envScope.restore();
    vi.restoreAllMocks();
  });

  it('reports supportsVendorResume per backend for UI gating', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true }, codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { supportsVendorResume?: boolean; available?: boolean }>;
    };

    expect(res?.available).toBe(true);
    expect(res?.backends?.claude).toBeTruthy();
    expect(typeof res.backends.claude.supportsVendorResume).toBe('boolean');
    expect(res.backends.codex).toMatchObject({
      available: true,
      supportsVendorResume: true,
    });
    expect(res.backends.kiro).toBeTruthy();
    expect(typeof res.backends.kiro.supportsVendorResume).toBe('boolean');
    expect(res.backends.customAcp).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
    expect(res.backends.pi).toBeTruthy();
    expect(typeof res.backends.pi.supportsVendorResume).toBe('boolean');
    expect(res.backends.copilot).toBeTruthy();
  });

  it('marks catalog-defined ACP backends available even when the CLI snapshot does not report them', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends.customAcp).toMatchObject({ available: true });
    expect(res.backends.kiro).toMatchObject({ available: true });
    expect(res.backends.ohMyPi).toMatchObject({ available: true });
  });

  it('does not synthesize a CodeRabbit backend from env overrides or PATH probes', async () => {
    await withTempDir('happier-coderabbit-path-test-', async (dir) => {
      const bin = join(dir, 'coderabbit');
      await writeFile(
        bin,
        '#!/usr/bin/env bash\n' +
          'echo \"coderabbit\"',
        'utf8',
      );
      await chmod(bin, 0o755);

      const pathLookup = process.env.PATH ?? '';
      envScope.patch({
        HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
        PATH: `${dir}${pathLookup ? `:${pathLookup}` : ''}`,
      });

      const res = await executionRunsCapability.detect({
        context: {
          cliSnapshot: makeCliSnapshot({ claude: { available: true } }),
        },
        request: { id: 'tool.executionRuns' },
      }) as {
        available: boolean;
        backends: { coderabbit?: { available?: boolean } };
      };

      expect(res?.available).toBe(true);
      expect(res?.backends?.coderabbit).toMatchObject({
        available: false,
        supportsVendorResume: false,
        intents: ['review'],
      });
    });
  });

  it('reports Codex resume support from the effective runtime mode (HAPPIER_CODEX_BACKEND_MODE)', async () => {
    process.env.HAPPIER_CODEX_BACKEND_MODE = 'mcp';

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { supportsVendorResume?: boolean; available?: boolean }>;
    };

    expect(res?.available).toBe(true);
    expect(res.backends.codex).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
  });

  it('reuses the common intent list for catalog-backed execution runs', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true }, codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      intents: readonly string[];
      backends: Record<string, { intents: readonly string[]; available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.backends.claude).toBeTruthy();
    expect(res.backends.codex).toBeTruthy();
    expect(res.backends.customAcp).toBeTruthy();
    expect(res.backends.ohMyPi).toBeTruthy();
    expect(res.backends.coderabbit).toMatchObject({ intents: ['review'] });

    expect(res.intents).toContain('memory_hints');
    for (const backendId of ['claude', 'codex', 'customAcp', 'ohMyPi']) {
      expect(res.backends[backendId]?.intents).toBe(res.intents);
    }
  });

  it('returns only protocol-defined execution-run intents', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true }, codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      intents: readonly string[];
      backends: Record<string, { intents: readonly string[] }>;
    };

    for (const intent of res.intents) {
      expect(ExecutionRunIntentSchema.safeParse(intent).success).toBe(true);
    }
    for (const backend of Object.values(res.backends)) {
      for (const intent of backend.intents) {
        expect(ExecutionRunIntentSchema.safeParse(intent).success).toBe(true);
      }
    }
  });

  it('projects contributed execution-run profile descriptors from the contribution registry', async () => {
    const profile = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'acme.execution-runs',
      definition: {
        id: 'acme.review.profile',
        kind: 'executionRun.profile' as const,
        version: '1.0.0',
        intent: 'review' as const,
        displayKey: 'plugins.acme.executionRuns.review.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none' as const,
        hidden: false,
        actionIds: [],
      },
    };
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      executionRunProfiles: [profile],
      executionRunProfilesById: new Map([
        ['acme.review.profile', profile],
      ]),
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      executionRunProfiles: readonly {
        id: string;
        kind: string;
        version: string;
        intent: string;
        displayKey: string;
        capabilityGates: readonly unknown[];
        permissionGates: readonly unknown[];
        actionIds: readonly string[];
        hidden: boolean;
        redaction: string;
      }[];
    };

    expect(res.executionRunProfiles).toEqual([
      {
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        version: '1.0.0',
        intent: 'review',
        displayKey: 'plugins.acme.executionRuns.review.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        actionIds: [],
      },
    ]);
  });

  it('marks plugin backends with backend-owned runtimeCore available', async () => {
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      backendDefinitionsById: new Map([
        [
          'plugin.review',
          {
            id: 'plugin.review',
            providerId: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.review', providerId: 'plugin.provider' },
            getRuntimeCore: async () => async () => ({
              runtimeCore: {
                createSessionRuntime: async () => {
                  throw new Error('not reached');
                },
                createExecutionRunBackend: () => {
                  throw new Error('not reached');
                },
              },
            }),
          },
        ],
      ]),
      providerDefinitionsById: new Map([
        [
          'plugin.provider',
          {
            id: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.provider', ownedBackendIds: ['plugin.review'] },
          },
        ],
      ]),
      catalogEntriesById: {},
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends['plugin.review']).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
  });

  it('marks catalog entries with an ACP runtime definition bridge available', async () => {
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      catalogEntriesById: {
        'plugin.acp': {
          id: 'plugin.acp',
          cliSubcommand: 'plugin-acp',
          vendorResumeSupport: 'unsupported',
          getAcpRuntimeDefinitionBridge: async () => ({
            exec: {
              systemTools: {
                resolve: async () => {
                  throw new Error('not reached');
                },
              },
            },
            createDefinition: () => {
              throw new Error('not reached');
            },
          }),
        },
      },
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends['plugin.acp']).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
  });

  it('narrows plugin backend intents to backend-declared execution-run review intents', async () => {
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      backendDefinitionsById: new Map([
        [
          'plugin.review',
          {
            id: 'plugin.review',
            providerId: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.review', providerId: 'plugin.provider' },
            capabilities: normalizePluginBackendCapabilitiesV1({
              executionRun: {
                supported: true,
                review: {
                  intents: ['review'],
                },
              },
            }),
            getRuntimeCore: async () => async () => ({
              runtimeCore: {
                createSessionRuntime: async () => {
                  throw new Error('not reached');
                },
                createExecutionRunBackend: () => {
                  throw new Error('not reached');
                },
              },
            }),
          },
        ],
      ]),
      providerDefinitionsById: new Map([
        [
          'plugin.provider',
          {
            id: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.provider', ownedBackendIds: ['plugin.review'] },
          },
        ],
      ]),
      catalogEntriesById: {},
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      intents: readonly string[];
      backends: Record<string, { intents: readonly string[]; available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.intents).toContain('plan');
    expect(res.backends['plugin.review']).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
    expect(res.backends['plugin.review']?.intents).toEqual(['review']);
  });

  it('marks plugin-contributed backends unavailable when runtimeCore proof is missing', async () => {
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      backendDefinitionsById: new Map([
        [
          'plugin.review',
          {
            id: 'plugin.review',
            providerId: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.review', providerId: 'plugin.provider' },
          },
        ],
      ]),
      providerDefinitionsById: new Map([
        [
          'plugin.provider',
          {
            id: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.provider', ownedBackendIds: ['plugin.review'] },
          },
        ],
      ]),
      catalogEntriesById: {},
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends['plugin.review']).toMatchObject({
      available: false,
      supportsVendorResume: false,
    });
  });

  it('marks plugin-contributed backends unavailable when execution-run support is explicitly disabled', async () => {
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      backendDefinitionsById: new Map([
        [
          'plugin.review',
          {
            id: 'plugin.review',
            providerId: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.review', providerId: 'plugin.provider' },
            capabilities: normalizePluginBackendCapabilitiesV1({
              executionRun: { supported: false },
            }),
            getRuntimeCore: async () => async () => ({
              runtimeCore: {
                createSessionRuntime: async () => {
                  throw new Error('not reached');
                },
                createExecutionRunBackend: () => {
                  throw new Error('not reached');
                },
              },
            }),
          },
        ],
      ]),
      providerDefinitionsById: new Map([
        [
          'plugin.provider',
          {
            id: 'plugin.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: 'plugin.provider', ownedBackendIds: ['plugin.review'] },
          },
        ],
      ]),
      catalogEntriesById: {},
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({}),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends['plugin.review']).toMatchObject({
      available: false,
      supportsVendorResume: false,
    });
  });
});
