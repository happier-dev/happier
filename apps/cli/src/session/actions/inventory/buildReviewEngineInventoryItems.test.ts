import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, buildBackendTargetKeyV2, PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { readReviewNarratorOptions } from '@happier-dev/protocol/inputs/inputOptions';
import { readAgentTargetReadinessV1 } from '@happier-dev/protocol/actions/executor/agents/agentBackendReadiness';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';

const registryMocks = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getReloadState: vi.fn<() => { activeRegistry: object | null }>(() => ({ activeRegistry: null })),
  isRuntimeRegistryCurrent: vi.fn(() => true),
}));

vi.mock('@/plugins/projection/registry/builtIn/snapshot', () => ({
  getResolvedContributionRegistry: registryMocks.getResolvedContributionRegistry,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: registryMocks.getReloadState,
    isRuntimeRegistryCurrent: registryMocks.isRuntimeRegistryCurrent,
  },
}));

import { buildReviewEngineInventory, buildReviewEngineInventoryItems as buildReviewInventory } from './buildReviewEngineInventoryItems';
const emptyCatalog = { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } satisfies AcpCatalogSnapshotV1;
const buildReviewEngineInventoryItems = (params: Parameters<typeof buildReviewInventory>[0]) => buildReviewInventory({
  acpCatalogSnapshot: emptyCatalog, ...params,
});

function runCapableDefinition(definition: Record<string, unknown>) {
  return {
    ...definition,
    primary: 'executionRuns',
    capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
  };
}

describe('buildReviewEngineInventoryItems', () => {
  it.each([undefined, 201])('preserves the requested roster size without an implicit ceiling (limit %s)', async limit => {
    const agents = Array.from({ length: 202 }, (_, index) => projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id: `reviewer-${index}`, title: `Reviewer ${index}`,
        primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }),
    }));
    const items = await buildReviewEngineInventoryItems({
      limit,
      registrySnapshot: { agentDefinitionsById: new Map(agents.map(agent => [agent.id, agent])), executionRunProfiles: [] },
    });
    expect(items.map(item => item.engineId)).toEqual(agents.slice(0, limit).map(agent => agent.id));
  });

  it('projects optional start consent from the selected profile option without deciding whether it is required', async () => {
    const agent = projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id: 'reviewer', title: 'Reviewer',
        primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }),
    });
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'cost-profile', installSource: 'archive' } as const;
    const profileCatalog = buildExecutionRunProfileCatalog(['costly', 'ordinary'].map(id => ({
      pluginId: 'acme.review', sourceCustody: profileSourceCustody,
      definition: { id, intent: 'review' as const, title: id, promptAsset: 'prompt', compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
        ...(id === 'costly' ? {
          metadata: { reviewCostConsentOption: 'acceptCost' },
          optionsSchema: { type: 'object' as const, additionalProperties: false as const, properties: {
            acceptCost: { type: 'boolean' as const, title: 'Accept estimate', description: 'This review may be expensive.' },
          } },
        } : {}),
      },
    })), { resolveAgentIdentity: id => id === agent.id ? agent.identity ?? null : null });
    const inventory = await buildReviewEngineInventory({
      acpCatalogSnapshot: emptyCatalog, profileCatalog,
      registrySnapshot: { agentDefinitionsById: new Map([[agent.id, agent]]), executionRunProfiles: [] },
      profileSelections: [{ engineId: agent.id, profileId: 'acme.review/ordinary', profileSourceCustody }],
    });
    expect(inventory.items[0]).toHaveProperty('costConsent', {
      optionKey: 'acceptCost', title: 'Accept estimate', description: 'This review may be expensive.',
    });
    expect(inventory.selectionItems?.[0]).not.toHaveProperty('costConsent');
  });

  it('preserves repository-only profiles and generic repository reviewers through inventory selection', async () => {
    const agents = ['generic', 'slices'].map(id => projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id, title: id, primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }),
    }));
    const registrySnapshot = { agentDefinitionsById: new Map(agents.map(agent => [agent.id, agent])), executionRunProfiles: [] };
    const profileCatalog = buildExecutionRunProfileCatalog([{ pluginId: 'acme.review', definition: {
      id: 'slices', title: 'Slices', intent: 'review', compatibleAgents: ['slices'], promptAsset: 'prompt',
      metadata: { reviewScopes: ['repository'] },
      defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' },
    } }], { resolveAgentIdentity: id => agents.find(agent => agent.id === id)?.identity ?? null });
    const list = (scope?: 'repository' | 'paths') => buildReviewEngineInventory({
      acpCatalogSnapshot: emptyCatalog, registrySnapshot, profileCatalog, ...(scope ? { scope } : {}),
    });
    const all = await list();
    expect(all.items.map(item => item.engineId)).toEqual(agents.map(agent => agent.id));
    expect(all.items.find(item => item.engineId === agents[1]!.id)?.reviewScopes).toEqual(['repository']);
    expect((await list('repository')).items.map(item => item.engineId)).toEqual(agents.map(agent => agent.id));
    expect((await list('paths')).items.map(item => item.engineId)).toEqual([agents[0]!.id]);
  });

  beforeEach(() => {
    registryMocks.getReloadState.mockReturnValue({ activeRegistry: null });
    registryMocks.isRuntimeRegistryCurrent.mockReturnValue(true);
  });

  it('derives transcript availability from the selected profile instruction support while preserving the default roster', async () => {
    const agent = projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id: 'reviewer', title: 'Reviewer',
        primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }),
    });
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'transcript-profile', installSource: 'archive' } as const;
    const profileCatalog = buildExecutionRunProfileCatalog(['native-cli', 'text-review'].map(id => ({
      pluginId: 'acme.review', sourceCustody: profileSourceCustody,
      definition: { id, intent: 'review' as const, title: id, promptAsset: 'prompt', compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
        ...(id === 'native-cli' ? { metadata: { reviewInstructionsInput: 'unsupported', reviewScopes: ['worktree'] } } : {}) },
    })), { resolveAgentIdentity: id => id === agent.id ? agent.identity ?? null : null });
    const inventory = await buildReviewEngineInventory({
      acpCatalogSnapshot: emptyCatalog,
      registrySnapshot: { agentDefinitionsById: new Map([[agent.id, agent]]), executionRunProfiles: [] },
      profileCatalog,
      profileSelections: [{ engineId: agent.id, profileId: 'acme.review/text-review', profileSourceCustody }],
    });
    expect(inventory.items).toEqual([expect.objectContaining({ profileId: 'acme.review/native-cli',
      capabilities: expect.objectContaining({ sessionTranscript: false }) })]);
    expect(inventory.selectionItems).toEqual([expect.objectContaining({ profileId: 'acme.review/text-review',
      capabilities: expect.objectContaining({ sessionTranscript: true }) })]);
    const scopedInventory = await buildReviewEngineInventory({
      acpCatalogSnapshot: emptyCatalog, scope: 'paths', profileCatalog,
      registrySnapshot: { agentDefinitionsById: new Map([[agent.id, agent]]), executionRunProfiles: [] },
      profileSelections: [{ engineId: agent.id, profileId: 'acme.review/text-review', profileSourceCustody }],
    });
    expect(scopedInventory.items).toEqual([]);
    expect(scopedInventory.selectionItems).toEqual([expect.objectContaining({ profileId: 'acme.review/text-review',
      reviewScopes: ['worktree', 'paths', 'repository'] })]);
  });

  it('retains every executable reviewer while consuming one Machine readiness projection and setup reason', async () => {
    const agents = ['ready-agent', 'setup-agent'].map(id => projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id, title: id, primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }),
    }));
    const machinesAgentsList = vi.fn(async () => ({ items: agents.map((agent, index) => ({
      agentId: agent.id, title: agent.id, installed: index === 0, version: null, latestVersion: null,
      update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
      platform: { supported: true }, install: { available: true, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    })) }));
    const items = await buildReviewEngineInventoryItems({
      registrySnapshot: { agentDefinitionsById: new Map(agents.map(agent => [agent.id, agent])), executionRunProfiles: [] },
      readReadiness: targets => readAgentTargetReadinessV1({ machinesAgentsList }, 'machine-1', targets.map(parseBackendTargetKeyV2), {}),
    });
    expect(items).toEqual([
      expect.objectContaining({ engineId: agents[0]!.id, available: true, readiness: 'ready' }),
      expect.objectContaining({ engineId: agents[1]!.id, available: false, readiness: 'notInstalled', unavailableCode: 'notInstalled' }),
    ]);
    expect(machinesAgentsList).toHaveBeenCalledTimes(1);
  });

  it('projects the Account model resolved by the Run launch owner and omits the bare Agent default', async () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(['claude', 'codex'].map(id => [id, {
        id, definition: { id, title: id }, richDefinition: { definition: runCapableDefinition({ id, title: id }) },
      }])), executionRunProfiles: [],
    });
    const accountSettings = AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: {
      'agent:happier.agent.claude/claude': { v: 1, updatedAt: 1, ref: {
        agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'account-review-model',
      } },
    } });
    const items = await buildReviewEngineInventoryItems({ accountSettings });
    expect(items.find(item => item.engineId === 'claude')).toMatchObject({ launchModelId: 'account-review-model' });
    expect(items.find(item => item.engineId === 'codex')).not.toHaveProperty('launchModelId');
    expect(items.find(item => item.engineId === 'codex')?.value).toBe(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }));
  });

  it('projects narration through real admitted Agent declarations without inferring it from engine identity or Session resume', async () => {
    const project = (id: string, structured: boolean) => projectManifestAgentContribution({
      pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({
        id, title: id, primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
          ...(structured ? { structuredOutput: { formats: ['json'] } } : {}) },
      }),
    });
    const capable = project('assistant', true);
    const findingsOnly = project('codex', false);
    // Current installed-plugin declarations cross the daemon reload projection boundary.
    // Admission, qualified identity and catalog projection stay real beneath it.
    registryMocks.getReloadState.mockReturnValue({ activeRegistry: { contributes: {
      agentDefinitionsById: new Map([[capable.id, capable], [findingsOnly.id, findingsOnly]]),
      executionRunProfiles: [], catalogEntriesById: {},
    } } });
    expect(await buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.review/assistant', capabilities: { structuredNarration: true, sessionTranscript: true } }),
      expect.objectContaining({ engineId: 'acme.review/codex', capabilities: { structuredNarration: false, sessionTranscript: true } }),
    ]);
  });

  it('projects review engines from cold manifest Agents and profiles without executable runtimes', async () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
            agentDefinitionsById: new Map([
        ['coderabbit', {
          id: 'coderabbit',
          definition: { id: 'coderabbit', title: 'CodeRabbit' },
          richDefinition: { definition: runCapableDefinition({ id: 'coderabbit', title: 'CodeRabbit' }) },
        }],
        ['deepsec', {
          id: 'deepsec',
          definition: { id: 'deepsec', title: 'DeepSec' },
          richDefinition: { definition: runCapableDefinition({ id: 'deepsec', title: 'DeepSec' }) },
        }],
      ]),
      executionRunProfiles: [
        { definition: { id: 'review', intent: 'review', compatibleAgents: ['coderabbit'] } },
        { definition: { id: 'security', intent: 'review', compatibleAgents: ['deepsec'] } },
      ],
    });

    expect(await buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'coderabbit', value: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'coderabbit' }), label: 'CodeRabbit' }),
      expect.objectContaining({ engineId: 'deepsec', value: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'deepsec' }), label: 'DeepSec' }),
    ]);
  });

  it('admits enabled Agents with execution-run create support regardless of provenance or primary runtime', async () => {
    type AgentDefinitionFixture = Readonly<{
      id: string;
      provenance: string;
      richDefinition: Readonly<{ definition: Readonly<Record<string, unknown>> }>;
    }>;
    const sessionAgent = (id: string): AgentDefinitionFixture => ({
      id,
      provenance: 'first_party',
      richDefinition: {
        definition: {
          id,
          title: id,
          primary: 'sessions',
          capabilities: { sessions: { open: ['create'], cancel: true } },
        },
      },
    });
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map<string, AgentDefinitionFixture>([
        ['claude', sessionAgent('claude')],
        ['codex', sessionAgent('codex')],
        ['opencode', sessionAgent('opencode')],
        ['plugin-reviewer', {
          id: 'plugin-reviewer',
          provenance: 'external',
          richDefinition: { definition: {
            id: 'plugin-reviewer', title: 'Plugin Reviewer', primary: 'executionRuns',
            capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
          } },
        }],
        ['resume-only', {
          id: 'resume-only',
          provenance: 'external',
          richDefinition: { definition: {
            id: 'resume-only', title: 'Resume only', primary: 'executionRuns',
            capabilities: { executionRuns: { open: ['resume'], checkpoint: true, stop: true } },
          } },
        }],
      ]),
      executionRunProfiles: [
        { definition: { id: 'resume-review', intent: 'review', compatibleAgents: ['resume-only'] } },
      ],
    });

    expect((await buildReviewEngineInventoryItems({})).map((item) => item.engineId)).toEqual([
      'claude', 'codex', 'opencode', 'plugin-reviewer',
    ]);
    expect((await buildReviewEngineInventoryItems({
      accountSettings: AccountSettingsSchema.parse({
        backendEnabledByTargetKey: {
          'agent:happier.agent.codex/codex': false,
          'backend:plugin-reviewer': false,
        },
      }),
    })).map((item) => item.engineId)).toEqual(['claude', 'opencode']);
  });

  it('lists an enabled configured ACP backend using its concrete target identity', async () => {
    const contribution = projectManifestAgentContribution({
      pluginId: 'happier.agent.custom-acp', provenance: 'first_party', source: { kind: 'bundled' },
      definition: PluginAgentContributionV2Schema.parse({ id: 'custom-acp', title: 'Custom ACP Agent',
        primary: 'sessions', runtime: { kind: 'custom' }, capabilities: { sessions: {
          open: ['create'], delivery: ['newTurn'], cancel: true,
        } } }),
    });
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([[contribution.id, contribution]]),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });
    const acpCatalogSnapshot = { status: 'ready', revision: 3, record: AcpCatalogRecordV1Schema.parse({
      v: 1, definitions: [{
        id: 'review-bot', name: 'review-bot', title: 'Review Bot', launch: { kind: 'command' as const, command: 'review-bot', args: [] },
         env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
          supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
      }],
    }) } satisfies AcpCatalogSnapshotV1;
    const targetKey = buildBackendTargetKeyV2({
      kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
    });
    const accountSettings = AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: {
      [targetKey]: { v: 1, updatedAt: 1, ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: 'configured-review-model' } },
    } });

    expect(await buildReviewEngineInventoryItems({ accountSettings, acpCatalogSnapshot })).toContainEqual(
      expect.objectContaining({ engineId: targetKey, value: targetKey, label: 'Review Bot',
        capabilities: { structuredNarration: false, sessionTranscript: true }, launchModelId: 'configured-review-model' }),
    );
    expect(await buildReviewEngineInventoryItems({
      acpCatalogSnapshot,
      accountSettings: AccountSettingsSchema.parse({
        ...accountSettings,
        backendEnabledByTargetKey: { [targetKey]: false },
      }),
    })).toEqual([]);
  });

  it('labels an installed external review Agent with its own declared title', async () => {
    const contribution = projectManifestAgentContribution({ pluginId: 'acme.review', provenance: 'external', source: { kind: 'path' },
      definition: PluginAgentContributionV2Schema.parse({ id: 'reviewer', title: 'Acme Reviewer', primary: 'sessions',
        runtime: { kind: 'custom' }, capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }),
    });
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([[contribution.id, contribution]]), executionRunProfiles: [],
    });
    const targetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: contribution.identity! });
    const accountSettings = AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: {
      [targetKey]: { v: 1, updatedAt: 1, ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: 'external-review-model' } },
    } });
    expect(await buildReviewEngineInventoryItems({ accountSettings })).toEqual([
      expect.objectContaining({ engineId: 'acme.review/reviewer', label: 'Acme Reviewer', launchModelId: 'external-review-model' }),
    ]);
  });

  it('projects an external review Agent that only the current runtime registry knows about', async () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });
    registryMocks.getReloadState.mockReturnValue({
      activeRegistry: {
        contributes: {
          agentDefinitionsById: new Map([
            ['acme.reviewer', {
              id: 'acme.reviewer',
              identity: { pluginId: 'acme.review', localId: 'reviewer' },
              definition: { id: 'acme.reviewer' },
              richDefinition: { definition: runCapableDefinition({ id: 'acme.reviewer', title: 'Acme Reviewer' }) },
            }],
          ]),
          catalogEntriesById: { 'acme.reviewer': { id: 'acme.reviewer' } },
          executionRunProfiles: [
            { pluginId: 'acme.review', definition: { id: 'review', intent: 'review', compatibleAgents: ['reviewer'] } },
          ],
        },
      },
    });

    expect(await buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer' }),
    ]);
  });

  it('falls back to the declared manifest title when an external Agent ships no CLI descriptor title', async () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme.reviewer', {
          id: 'acme.reviewer',
          definition: { id: 'acme.reviewer' },
          runtimeSpec: { id: 'acme.reviewer', title: 'Acme Reviewer CLI' },
          richDefinition: { definition: runCapableDefinition({ id: 'acme.reviewer' }) },
        }],
      ]),
      executionRunProfiles: [
        { definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
      ],
    });

    expect(await buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer CLI' }),
    ]);
  });

  it('hides a profile that declares exact paths unsupported for a paths scope', async () => {
    const profileCatalog = buildExecutionRunProfileCatalog([
      { id: 'review', intent: 'review', title: 'Review', promptAsset: 'prompt', compatibleAgents: ['coderabbit'],
        metadata: { reviewScopes: ['worktree'] }, defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' } },
      { id: 'paths-review', intent: 'review', title: 'Paths review', promptAsset: 'prompt', compatibleAgents: ['coderabbit'],
        metadata: { reviewScopes: ['worktree', 'paths'] }, defaults: { retention: 'resumable', runClass: 'bounded', io: 'requestResponse' } },
    ]);
    const buildSelectedInventory = (params: Parameters<typeof buildReviewEngineInventoryItems>[0] = {}) =>
      buildReviewEngineInventoryItems({ profileCatalog, ...params });
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['coderabbit', { id: 'coderabbit', definition: { id: 'coderabbit', title: 'CodeRabbit' }, richDefinition: { definition: runCapableDefinition({ id: 'coderabbit' }) } }],
        ['deepsec', { id: 'deepsec', definition: { id: 'deepsec', title: 'DeepSec' }, richDefinition: { definition: runCapableDefinition({ id: 'deepsec' }) } }],
      ]),
      executionRunProfiles: [
        { definition: {
          id: 'review', intent: 'review', compatibleAgents: ['coderabbit'],
          metadata: { reviewScopes: ['worktree'] },
          defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' },
        } },
        { definition: { id: 'security', intent: 'review', compatibleAgents: ['deepsec'] } },
      ],
    });

    expect((await buildSelectedInventory({ scope: 'paths' })).map((item) => item.engineId)).toEqual(['deepsec']);
    expect((await buildSelectedInventory()).map((item) => item.engineId)).toEqual(['coderabbit', 'deepsec']);
    expect(await buildSelectedInventory()).toEqual([
      expect.objectContaining({ engineId: 'coderabbit', profileId: 'review', reviewScopes: ['worktree'], retentionPolicy: 'ephemeral', available: true }),
      expect.objectContaining({ engineId: 'deepsec', reviewScopes: ['worktree', 'paths', 'repository'], retentionPolicy: 'resumable', available: true }),
    ]);
    expect(readReviewNarratorOptions({ items: await buildSelectedInventory() })).toContainEqual(
      expect.objectContaining({ retentionPolicy: 'ephemeral' }),
    );
    expect(await buildSelectedInventory({ includeDisabled: true, accountSettings: AccountSettingsSchema.parse({
      backendEnabledByTargetKey: { 'agent:happier.review.coderabbit/coderabbit': false },
    }) })).toContainEqual(expect.objectContaining({ engineId: 'coderabbit', enabled: false, available: false,
      unavailableCode: 'account_disabled', reviewScopes: ['worktree'] }));
  });
});
