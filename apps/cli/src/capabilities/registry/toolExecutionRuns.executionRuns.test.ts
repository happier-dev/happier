import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { executionRunsCapability } from './toolExecutionRuns';
import type { DetectCliSnapshot } from '../snapshots/cliSnapshot';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { withTempDir } from '../../testkit/fs/tempDir';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol';
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
      activationTargets: Object.freeze([]),
      hookRegistrations: Object.freeze([]),
      runtimeCoreHooksByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map(),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
      ...contributions,
    },
    resolveForBackendId: async () => null,
    resolveExecutionSurfaces: async () => ({
      terminalRuntime: null,
      directSessions: null,
      attach: null,
      sessionHandoff: null,
    }),
  };
}

describe('executionRunsCapability', () => {
  const envScope = createEnvKeyScope(['PATH', 'HAPPIER_CODERABBIT_REVIEW_CMD', 'HAPPIER_CODEX_BACKEND_MODE']);

  beforeEach(() => {
    envScope.restore();
    envScope.patch({
      HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
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

  it('detects native coderabbit availability from process PATH even when cliSnapshot.path is empty', async () => {
    // Ensure we test PATH detection (not the override).
    await withTempDir('happier-coderabbit-path-test-', async (dir) => {
      envScope.patch({ HAPPIER_CODERABBIT_REVIEW_CMD: undefined });

      const bin = join(dir, 'coderabbit');
      await writeFile(
        bin,
        '#!/usr/bin/env bash\n' +
          'echo \"coderabbit\"',
        'utf8',
      );
      await chmod(bin, 0o755);

      const pathLookup = process.env.PATH ?? '';
      envScope.patch({ PATH: `${dir}${pathLookup ? `:${pathLookup}` : ''}` });

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
      expect(res?.backends?.coderabbit?.available).toBe(true);
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
    expect(res.backends.coderabbit).toBeTruthy();

    expect(res.intents).toContain('memory_hints');
    for (const backendId of Object.keys(res.backends).filter((backendId) => backendId !== 'coderabbit')) {
      expect(res.backends[backendId]?.intents).toBe(res.intents);
    }

    expect(res.backends.coderabbit?.intents).toEqual(['review']);
    expect(res.backends.coderabbit?.intents).not.toBe(res.intents);
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
    for (const intent of res.backends.coderabbit?.intents ?? []) {
      expect(ExecutionRunIntentSchema.safeParse(intent).success).toBe(true);
    }
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

  it('treats plugin-contributed backends as available even without catalog entries or cli probes', async () => {
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
      available: true,
      supportsVendorResume: false,
    });
  });
});
