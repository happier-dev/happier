import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, buildBackendTargetKeyV2, PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';

const registryMocks = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getReloadState: vi.fn<() => { activeRegistry: object | null }>(() => ({ activeRegistry: null })),
  isRuntimeRegistryCurrent: vi.fn(() => true),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: registryMocks.getResolvedContributionRegistry,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: registryMocks.getReloadState,
    isRuntimeRegistryCurrent: registryMocks.isRuntimeRegistryCurrent,
  },
}));

import { buildReviewEngineInventoryItems as buildReviewInventory } from './buildReviewEngineInventoryItems';
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
  beforeEach(() => {
    registryMocks.getReloadState.mockReturnValue({ activeRegistry: null });
    registryMocks.isRuntimeRegistryCurrent.mockReturnValue(true);
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
      expect.objectContaining({ engineId: 'acme.review/assistant', capabilities: { structuredNarration: true } }),
      expect.objectContaining({ engineId: 'acme.review/codex', capabilities: { structuredNarration: false } }),
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
      expect.objectContaining({ engineId: 'coderabbit', value: 'coderabbit', label: 'CodeRabbit' }),
      expect.objectContaining({ engineId: 'deepsec', value: 'deepsec', label: 'DeepSec' }),
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
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });
    const accountSettings = AccountSettingsSchema.parse({});
    const acpCatalogSnapshot = { status: 'ready', revision: 3, record: AcpCatalogRecordV1Schema.parse({
      v: 1, definitions: [{
        id: 'review-bot', name: 'review-bot', title: 'Review Bot', command: 'review-bot',
        args: [], env: {}, capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown',
          supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
      }],
    }) } satisfies AcpCatalogSnapshotV1;
    const targetKey = buildBackendTargetKeyV2({
      kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
    });

    expect(await buildReviewEngineInventoryItems({ accountSettings, acpCatalogSnapshot })).toContainEqual(
      expect.objectContaining({ engineId: targetKey, value: targetKey, label: 'Review Bot',
        capabilities: { structuredNarration: false } }),
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
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme.reviewer', {
          id: 'acme.reviewer',
          identity: { pluginId: 'acme', localId: 'acme.reviewer' },
          definition: { id: 'acme.reviewer' },
          richDefinition: { definition: runCapableDefinition({ id: 'acme.reviewer', title: { key: 'acme.reviewer.title', fallback: 'Acme Reviewer' } }) },
          runtimeSpec: null,
        }],
      ]),
      executionRunProfiles: [
        { pluginId: 'acme', definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
      ],
    });

    expect(await buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer' }),
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
              identity: { pluginId: 'acme', localId: 'acme.reviewer' },
              definition: { id: 'acme.reviewer' },
              richDefinition: { definition: runCapableDefinition({ id: 'acme.reviewer', title: 'Acme Reviewer' }) },
            }],
          ]),
          catalogEntriesById: { 'acme.reviewer': { id: 'acme.reviewer' } },
          executionRunProfiles: [
            { pluginId: 'acme', definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
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
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['coderabbit', { id: 'coderabbit', definition: { id: 'coderabbit', title: 'CodeRabbit' }, richDefinition: { definition: runCapableDefinition({ id: 'coderabbit' }) } }],
        ['deepsec', { id: 'deepsec', definition: { id: 'deepsec', title: 'DeepSec' }, richDefinition: { definition: runCapableDefinition({ id: 'deepsec' }) } }],
      ]),
      executionRunProfiles: [
        { definition: {
          id: 'review', intent: 'review', compatibleAgents: ['coderabbit'],
          metadata: { reviewScopes: ['worktree'] },
        } },
        { definition: { id: 'security', intent: 'review', compatibleAgents: ['deepsec'] } },
      ],
    });

    expect((await buildReviewEngineInventoryItems({ scope: 'paths' })).map((item) => item.engineId)).toEqual(['deepsec']);
    expect((await buildReviewEngineInventoryItems({})).map((item) => item.engineId)).toEqual(['coderabbit', 'deepsec']);
  });
});
