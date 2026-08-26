import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { executionRunsCapability } from './toolExecutionRuns';
import type { DetectCliSnapshot } from '../snapshots/cliSnapshot';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { withTempDir } from '../../testkit/fs/tempDir';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol';
import * as engineRegistry from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedAgentContribution } from '../../plugins/projection/registry/types';

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
  options?: Readonly<{ currentPluginGenerationById?: ReadonlyMap<string, string> }>,
): Awaited<ReturnType<typeof engineRegistry.resolveCliEngineRegistry>> {
  return {
    contributions: {
      agents: Object.freeze([]),
            actions: Object.freeze([]),
      resources: Object.freeze([]),
      executionRunProfiles: Object.freeze([]),
      activationTargets: Object.freeze([]),
            catalogEntriesById: {},
      agentDefinitionsById: new Map(),
            executionRunProfilesById: new Map(),
      pluginDiagnosticsByPluginId: {},
      ...contributions,
    },
    resolveCurrentPluginGeneration: async (pluginId) => (
      options?.currentPluginGenerationById?.get(pluginId) ?? null
    ),
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
  const envScope = createEnvKeyScope([
    'PATH',
    'HAPPIER_CODERABBIT_REVIEW_CMD',
    'HAPPIER_CODEX_BACKEND_MODE',
    'HAPPIER_FEATURE_VOICE__ENABLED',
    'HAPPIER_FEATURE_VOICE_AGENT__ENABLED',
  ]);

  beforeEach(() => {
    envScope.restore();
    envScope.patch({
      HAPPIER_CODEX_BACKEND_MODE: undefined,
    });
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(
      makeCliEngineRegistryMock({}),
    );
  });

  it('marks a canonical execution-run Agent available without a legacy runtime getter', async () => {
    const agent: ResolvedAgentContribution = {
      id: 'plugin.review',
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'acme.review',
      definition: {
        kindVersion: 1 as const,
        id: 'plugin.review',
        ownedBackendIds: ['plugin.review'],
      },
      richDefinition: {
        provenance: 'external' as const,
        definition: {
          id: 'plugin.review',
          title: 'Plugin review',
          runtime: { kind: 'custom' },
          primary: 'executionRuns' as const,
          capabilities: {
            executionRuns: {
              open: ['create'],
              checkpoint: false,
              stop: true,
            },
          },
        },
      },
    };
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      agents: [agent],
      agentDefinitionsById: new Map([[agent.id, agent]]),
    }));

    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean }> };

    expect(result.backends['plugin.review']).toMatchObject({ available: true });
  });

  it('advertises the exact V2 facts required before detached or start-and-wait dispatch', async () => {
    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({ codex: { available: true } }) },
      request: { id: 'tool.executionRuns' },
    }) as {
      protocolVersion?: unknown;
      features?: unknown;
    };

    expect(result.protocolVersion).toBe(2);
    expect(result.features).toEqual({ detachedScope: true, startAndWait: true });
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
      // Codex is experimental: without a concrete Session runtime selection,
      // this UI capability must not manufacture a second decision path.
      supportsVendorResume: false,
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
      });
    });
  });

  it('does not affirm experimental Codex resume without a Session runtime selection', async () => {
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
    expect(res.intents).toContain('memory_hints');
    for (const backendId of ['claude', 'codex', 'customAcp', 'ohMyPi', 'coderabbit']) {
      expect(res.backends[backendId]?.intents).toBe(res.intents);
    }
  });

  it('omits voice_agent and projects its canonical blocker when voice.agent is disabled', async () => {
    envScope.patch({
      HAPPIER_FEATURE_VOICE__ENABLED: '1',
      HAPPIER_FEATURE_VOICE_AGENT__ENABLED: '0',
    });

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      intents: readonly string[];
      backends: Record<string, { intents: readonly string[] }>;
      disabledIntents?: Record<string, { disabledBy: string; disabledReason: string }>;
    };

    expect(res.available).toBe(true);
    expect(res.intents).not.toContain('voice_agent');
    for (const backend of Object.values(res.backends)) {
      expect(backend.intents).not.toContain('voice_agent');
    }
    expect(res.disabledIntents?.voice_agent).toEqual({
      disabledBy: 'local_policy',
      disabledReason: 'flag_disabled',
    });
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
        id: 'review-profile',
        intent: 'review' as const,
        title: 'Acme review',
        promptAsset: 'review-prompt',
        compatibleAgents: ['acme-review'],
        generationId: null,
        available: true,
        defaults: {
          retention: 'ephemeral' as const,
          runClass: 'bounded' as const,
          io: 'requestResponse' as const,
        },
      },
    };
    vi.spyOn(engineRegistry, 'resolveCliEngineRegistry').mockResolvedValue(makeCliEngineRegistryMock({
      executionRunProfiles: [profile],
      executionRunProfilesById: new Map([
        ['acme.execution-runs/review-profile', profile],
      ]),
    }, {
      currentPluginGenerationById: new Map([['acme.execution-runs', 'immutable-profile-1']]),
    }));

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      executionRunProfiles: readonly {
        id: string;
        intent: string;
        title: string;
        promptAsset: string;
        compatibleAgents: readonly string[];
        defaults: Readonly<{ retention: string; runClass: string; io: string }>;
        generationId: string | null;
        available: boolean;
      }[];
    };

    expect(res.executionRunProfiles).toEqual([
      {
        id: 'acme.execution-runs/review-profile',
        intent: 'review',
        title: 'Acme review',
        promptAsset: 'review-prompt',
        compatibleAgents: ['acme-review'],
        generationId: 'immutable-profile-1',
        available: true,
        defaults: {
          retention: 'ephemeral',
          runClass: 'bounded',
          io: 'requestResponse',
        },
      },
    ]);
  });
});
