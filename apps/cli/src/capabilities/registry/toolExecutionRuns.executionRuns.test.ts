import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { executionRunsCapability } from './toolExecutionRuns';
import type { DetectCliSnapshot } from '../snapshots/cliSnapshot';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir, withTempDir } from '../../testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '../../configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../../plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '../../plugins/runtime/reload/singleton';
import { AccountSettingsSchema, ExecutionRunIntentSchema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '../../settings/accountSettings/activeAccountSettingsSnapshot';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

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

describe('executionRunsCapability', () => {
  const homeScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let home = '';
  let runtimeFixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  const envScope = createEnvKeyScope([
    'PATH',
    'HAPPIER_CODERABBIT_REVIEW_CMD',
    'HAPPIER_CODEX_BACKEND_MODE',
    'HAPPIER_FEATURE_VOICE__ENABLED',
    'HAPPIER_FEATURE_VOICE_AGENT__ENABLED',
  ]);

  beforeAll(async () => {
    home = await createTempDir('happier-execution-capability-runtime-');
    homeScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const agent = (id: string) => ({ id, title: 'External review Agent', runtime: { kind: 'custom' },
      primary: 'executionRuns', capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } });
    const daemon = (id: string) => `export function activate(api) {
      api.agents.register('${id}', () => { throw new Error('Capability observation must not start an Agent'); });
    }`;
    runtimeFixture = await createAuthoredAdmittedPluginRuntimeFixture({
      happyHomeDir: configuration.happyHomeDir,
      controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.review', contributes: { agents: [agent('review-agent')] } }),
        files: { 'daemon.mjs': daemon('review-agent') } },
      { manifest: createPluginManifestV2Fixture({ id: 'acme.execution-runs', contributes: {
        agents: [agent('acme-review')],
        executionRunProfiles: [{ id: 'review-profile', intent: 'review', title: 'Acme review', promptAsset: 'review-prompt',
          optionsSchema: { type: 'object', additionalProperties: false, properties: {
            effort: { type: 'string', enum: ['fast', 'deep'] },
            executablePath: { type: 'string', title: 'Executable path' },
          } },
          optionsInputHints: { fields: [{ path: 'effort', title: 'Effort', widget: 'select',
            options: [{ value: 'fast', label: 'Fast' }, { value: 'deep', label: 'Deep' }] }] },
          compatibleAgents: ['acme-review'], defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' } }],
        resources: [{ id: 'review-prompt-resource', kind: 'prompt', path: './review.md', contentType: 'text/markdown' }],
        promptAssets: [{ id: 'review-prompt', kind: 'systemPrompt', resource: 'review-prompt-resource', target: { kind: 'agent', agent: 'acme-review' } }],
      } }), files: { 'daemon.mjs': daemon('acme-review'), 'review.md': 'Review the current change.' } }],
      runtimeOptions: { pluginIds: [
        'happier.agent.claude', 'happier.agent.codex', 'happier.agent.custom-acp',
        'happier.agent.pi', 'happier.agent.kiro', 'happier.agent.copilot',
        'happier.agent.qwen', 'happier.agent.ohmypi', 'happier.review.coderabbit', 'acme.review', 'acme.execution-runs',
      ] },
    });
    await runtimeFixture.registry.activateContributionsOnDemand([
      { pluginId: 'happier.agent.custom-acp', family: 'agents', localId: 'custom-acp' },
      { pluginId: 'happier.review.coderabbit', family: 'agents', localId: 'coderabbit' },
      { pluginId: 'happier.review.coderabbit', family: 'executionRunProfiles', localId: 'review' },
    ]);
  });

  afterAll(async () => {
    try {
      await runtimeFixture?.dispose();
    } finally {
      homeScope.restore();
      reloadConfiguration();
      if (home) await removeTempDir(home);
    }
  });

  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({
      source: 'cache', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: AccountSettingsSchema.parse({}),
      acpCatalog: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
    });
    envScope.restore();
    envScope.patch({
      HAPPIER_CODEX_BACKEND_MODE: undefined,
    });
  });

  it('marks a canonical execution-run Agent available without a legacy runtime getter', async () => {
    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean; intents?: readonly string[] }> };

    expect(result.backends['acme.review/review-agent']).toMatchObject({ available: true });
    expect(result.backends['acme.review/review-agent']?.intents).toContain('review');
  });

  it('projects a configured ACP review target from the active catalog row and current preferences', async () => {
    // Replace only filesystem publication; exercise the actual registry and inventory owners.
    vi.restoreAllMocks();
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
      id: 'review-bot', name: 'review-bot', title: 'Review Bot', launch: { kind: 'command' as const, command: 'review-bot', args: [] },
      createdAt: 1, updatedAt: 1,
    }] });
    setActiveAccountSettingsSnapshot({
      source: 'cache', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: AccountSettingsSchema.parse({}),
      acpCatalog: { status: 'ready', revision: 1, record },
    });

    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean; intents?: readonly string[]; reviewScopes?: readonly string[] }> };

    const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
    expect(result.backends[targetKey]).toMatchObject({
      available: true, intents: expect.arrayContaining(['review']), reviewScopes: ['worktree', 'paths'],
    });
    expect(result.backends['custom-acp']).toBeUndefined();
    expect(result.backends.customAcp).toBeUndefined();

    setActiveAccountSettingsSnapshot({
      source: 'cache', settingsVersion: 2, loadedAtMs: 2, settingsSecretsReadKeys: [],
      settings: AccountSettingsSchema.parse({
        backendEnabledByTargetKey: { [targetKey]: false },
      }),
      acpCatalog: { status: 'ready', revision: 1, record },
    });
    const disabledResult = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean; intents?: readonly string[] }> };
    expect(disabledResult.backends[targetKey]).toMatchObject({ available: false });
    expect(disabledResult.backends[targetKey]?.intents).not.toContain('review');
  });

  it('keeps built-in execution protocol admission independent of unavailable configured ACP authority', async () => {
    vi.restoreAllMocks();
    const unavailable: AcpCatalogSnapshotV1 = { status: 'unavailable', reason: 'account-unavailable' };
    setActiveAccountSettingsSnapshot({
      source: 'cache', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: AccountSettingsSchema.parse({}), acpCatalog: unavailable,
    });
    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    });
    expect(result).toMatchObject({
      available: true,
      protocolVersion: 2,
      features: { detachedScope: true, startAndWait: true, exactInputResults: true },
      backends: { claude: { available: true } },
    });
  });

  it('advertises the exact V2 facts required before detached or start-and-wait dispatch', async () => {
    // Exercise the real catalog/projection below the filesystem boundary.
    vi.restoreAllMocks();
    const result = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({ codex: { available: true } }) },
      request: { id: 'tool.executionRuns' },
    }) as {
      protocolVersion?: unknown;
      features?: unknown;
    };

    expect(result.protocolVersion).toBe(2);
    expect(result.features).toEqual({
      detachedScope: true,
      startAndWait: true,
      exactInputResults: true,
      runScopedAgentBindings: true,
      secretReferenceOverlay: true,
    });
    expect((result as { intents?: readonly string[] }).intents).toContain('agent');
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
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
    expect(res.backends.customAcp).toBeUndefined();
    expect(res.backends['custom-acp']).toBeUndefined();
    expect(res.backends.pi).toBeTruthy();
    expect(typeof res.backends.pi.supportsVendorResume).toBe('boolean');
    expect(res.backends.copilot).toBeTruthy();
  });

  it('projects the declared Qwen capability independently of CLI detection', async () => {
    const undetected = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean }> };
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ qwen: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.available).toBe(true);
    expect(res.backends.customAcp).toBeUndefined();
    expect(res.backends.qwen).toMatchObject({ available: true });
    expect(res.backends.qwen).toEqual(undetected.backends.qwen);
  });

  it('keeps the declared CodeRabbit capability independent of env overrides and PATH probes', async () => {
    const declared = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }> };
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
        available: true,
        supportsVendorResume: false,
      });
      expect(res.backends.coderabbit).toEqual(declared.backends.coderabbit);
    });
  });

  it('does not affirm experimental Codex resume without a Session runtime selection', async () => {
    const declared = await executionRunsCapability.detect({
      context: { cliSnapshot: makeCliSnapshot({}) },
      request: { id: 'tool.executionRuns' },
    }) as { backends: Record<string, { available?: boolean; supportsVendorResume?: boolean }> };
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
    expect(res.backends.codex).toEqual(declared.backends.codex);
  });

  it('projects review intent only for agents selected by the review engine inventory', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true }, codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      intents: readonly string[];
      backends: Record<string, { intents: readonly string[]; reviewScopes: readonly string[]; available?: boolean; supportsVendorResume?: boolean }>;
    };

    expect(res.backends.claude).toBeTruthy();
    expect(res.backends.codex).toBeTruthy();
    expect(res.backends.customAcp).toBeUndefined();
    expect(res.backends.ohMyPi).toBeTruthy();
    expect(res.intents).toContain('memory_hints');
    for (const backendId of ['claude', 'codex', 'ohMyPi', 'coderabbit']) {
      expect(res.backends[backendId]?.intents).toContain('review');
      expect(res.backends[backendId]?.intents).toContain('plan');
    }
    expect(res.backends.coderabbit.reviewScopes).toEqual(['worktree']);
    for (const backendId of ['claude', 'codex', 'ohMyPi']) {
      expect(res.backends[backendId]?.reviewScopes).toEqual(['worktree', 'paths']);
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
        sourceCustody: import('@happier-dev/protocol').PluginSourceCustodyV1 | null;
        available: boolean;
      }[];
    };

    const profiles = res.executionRunProfiles.filter(profile => profile.id === 'acme.execution-runs/review-profile');
    const generation = runtimeFixture?.committed.generations.get('acme.execution-runs');
    if (!generation) throw new Error('Expected admitted external profile generation');
    expect(JSON.parse(JSON.stringify(profiles))).toEqual([
      {
        id: 'acme.execution-runs/review-profile',
        intent: 'review',
        title: 'Acme review',
        promptAsset: 'review-prompt',
        compatibleAgents: ['acme-review'],
        sourceCustody: {
          kind: 'managed', immutableGenerationId: generation.immutableGenerationId, installSource: 'localPath',
        },
        available: true,
        optionsSchema: { type: 'object', additionalProperties: false, properties: {
          effort: { type: 'string', enum: ['fast', 'deep'] },
          executablePath: { type: 'string', title: 'Executable path' },
        } },
        optionsInputHints: { fields: [{ path: 'effort', title: 'Effort', widget: 'select',
          options: [{ value: 'fast', label: 'Fast' }, { value: 'deep', label: 'Deep' }] }] },
        defaults: {
          retention: 'ephemeral',
          runClass: 'bounded',
          io: 'requestResponse',
        },
      },
    ]);
  });
});
