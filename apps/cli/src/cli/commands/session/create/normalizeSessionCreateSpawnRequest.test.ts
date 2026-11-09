import { describe, expect, it, vi } from 'vitest';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { parseSessionCreateSpawnOptions } from './parseSessionCreateSpawnOptions';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import {
  normalizeSessionCreateSpawnRequest,
  type SessionCreateSpawnRequestNormalizerDeps,
} from './normalizeSessionCreateSpawnRequest';

function createDeps(
  overrides: Partial<SessionCreateSpawnRequestNormalizerDeps> = {},
): SessionCreateSpawnRequestNormalizerDeps {
  return {
    activeServerId: 'server-1',
    defaultAgentId: 'claude',
    readSettings: async () => ({
      machineIdByServerIdByAccountId: {
        'server-1': { 'account-1': 'machine-account-current' },
      },
      lastTokenSubByServerId: { 'server-1': 'account-1' },
    }),
    readAgentDefinitions: () => [
      {
        id: 'claude',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      {
        id: 'review-bot',
        identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
      },
    ],
    now: () => 100,
    ...overrides,
  };
}

describe('normalizeSessionCreateSpawnRequest', () => {
  it('admits the P0-DATA no-prompt Codex recipe with read-only permission and low effort', async () => {
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const machineId = '3ca2700f-c0a8-440f-be06-cb4f3f51cb01';
    const parsed = parseSessionCreateSpawnOptions([
      'create', '--path', '/tmp/forge-qa-pr54-20261024', '--agent', 'codex',
      '--model', 'gpt-5.6-luna', '--reasoning-effort', 'low',
      '--permission-mode', 'read-only', '--auth', 'default',
      '--machine-id', machineId, '--server-id', serverId,
      '--title', 'P0-DATA — Investigate checkout recovery', '--json',
    ]);
    const activeServerId = 'stack_agent-qa-prs-issues__id_default';
    const deps = createDeps({
      activeServerId,
      readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values(),
    });
    await expect(normalizeSessionCreateSpawnRequest(parsed.spawnRequest, deps)).rejects.toMatchObject({
      details: { field: 'serverId', allowedValues: [activeServerId] },
    });
    const { serverId: _serverId, ...correctedRequest } = parsed.spawnRequest;
    const normalized = await normalizeSessionCreateSpawnRequest(correctedRequest, deps);
    expect(normalized.input).toMatchObject({
      executionTarget: { serverId: activeServerId, machineId },
      directory: { kind: 'path', path: '/tmp/forge-qa-pr54-20261024' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      permissionMode: 'read-only',
      modelSelection: { ref: { modelId: 'gpt-5.6-luna' } },
      configuration: { options: { reasoning_effort: { value: 'low', updatedAtMs: 100 } } },
    });
    expect(normalized.input).not.toHaveProperty('initialInput');
    expect(parsed.connectedServicesAuthIntent).toEqual({ kind: 'default' });
  });
  it('resolves repeated capability names to catalog IDs and rejects missing names with not_found', async () => {
    const deps = {
      ...createDeps(),
      readCapabilityCatalogs: async () => ({
        mcp: [{ id: 'server-docs', name: 'docs' }, { id: 'server-linear', name: 'linear' }],
        skills: [{ id: 'skill-lint', name: 'lint' }, { id: 'skill-review', name: 'review' }],
      }),
    };
    const request = {
      directory: '/workspace', backendTargetKey: null,
      capabilitySelectionNames: { skills: { include: ['lint', 'lint'], exclude: ['review'] }, mcp: { include: ['docs'], exclude: ['linear'] } },
    };
    const resolved = await normalizeSessionCreateSpawnRequest(request, deps);
    expect(resolved.input).toMatchObject({ capabilitySelection: {
      mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-docs'], forceExcludeServerIds: ['server-linear'] },
      skills: { v: 1, forceIncludeSkillIds: ['skill-lint'], forceExcludeSkillIds: ['skill-review'], excludeNativeSkillNames: [] },
    } });
    expect(resolved.input).not.toHaveProperty('capabilitySelectionNames');
    await expect(normalizeSessionCreateSpawnRequest({ ...request,
      capabilitySelectionNames: { skills: { include: ['missing'], exclude: [] }, mcp: { include: [], exclude: [] } },
    }, deps)).rejects.toMatchObject({ code: 'not_found', kind: 'skill', name: 'missing' });
  });
  it.each([
    'acpBackend:chosen',
    'agent:happier.agent.custom-acp/custom-acp:definition:chosen',
    'backend:chosen:configured:chosen',
  ])('preserves the configured definition through ordinary Session spawn admission: %s', async (backendTargetKey) => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project', backendTargetKey, modelId: 'chosen-model',
    }, createDeps({ readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values() }));
    expect(normalized.agentId).toBe('custom-acp');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'chosen',
    });
    expect(normalized.input.modelSelection?.ref).toMatchObject({
      agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:chosen', modelId: 'chosen-model',
    });
  });

  it.each([
    ['--agent', 'claude'],
    ['--backend', 'agent:claude'],
    ['--backend', 'agent:happier.agent.claude/claude'],
  ])('normalizes the parsed bundled Agent selection to its declared identity: %s %s', async (flag, selection) => {
    const parsed = parseSessionCreateSpawnOptions([
      'create', '--path', '/repo/project', flag, selection,
      '--model', 'claude-sonnet-4-6', '--reasoning-effort', 'low',
    ]);
    const normalized = await normalizeSessionCreateSpawnRequest(parsed.spawnRequest,
      createDeps({ readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values() }));
    expect(normalized.agentId).toBe('claude');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    });
    expect(normalized.input.modelSelection?.ref).toMatchObject({
      agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'claude-sonnet-4-6',
    });
    expect(normalized.input.configuration?.options.reasoning_effort).toEqual({ value: 'low', updatedAtMs: 100 });
  });
  it('normalizes permission aliases and rejects unknown modes before Action dispatch', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'read_only',
    }, createDeps());

    expect(normalized.input.permissionMode).toBe('read-only');
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'surprise-me',
    }, createDeps())).rejects.toThrow(/permission mode/i);
  });

  it('keeps a Provider-bound literal model named default while native default still resets', async () => {
    const providerBound = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
      providerConnectionId: 'provider-1',
    }, createDeps());

    expect(providerBound.input.modelSelection).toMatchObject({
      v: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: 'provider-1',
        modelId: 'default',
      },
    });

    const nativeDefault = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
    }, createDeps());

    expect(nativeDefault.input.modelSelection).toBeUndefined();
  });

  it('emits one strict V2 request with the exact target and contributed external Agent identity', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'backend:review-bot',
      modelId: 'review-model',
      providerConnectionId: 'provider-1',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      configOptions: { reasoning_effort: 'high' },
      title: 'Review',
      initialInput: { text: 'Please review this branch.' },
    }, createDeps());

    expect(normalized).toEqual({
      agentId: 'review-bot',
      input: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-account-current' },
        directory: { kind: 'path', path: '/repo/project' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
        modelSelection: {
          v: 1,
          updatedAt: 100,
          ref: {
            agentTargetKey: 'agent:com.acme.review/review-bot',
            providerConnectionId: 'provider-1',
            modelId: 'review-model',
          },
        },
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        configuration: {
          mode: { value: null, updatedAtMs: 100 },
          model: { value: null, updatedAtMs: 100 },
          permissionIntent: { value: null, updatedAtMs: 100 },
          options: {
            reasoning_effort: { value: 'high', updatedAtMs: 100 },
          },
        },
        title: 'Review',
        initialInput: { text: 'Please review this branch.' },
      },
    });
  });

  it('resolves a qualified external Agent key through the catalog before legacy conversion', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'agent:com.acme.review/review-bot',
      modelId: 'review-model',
    }, createDeps({
      readAgentDefinitions: () => [
        {
          id: 'com.acme.review/review-bot',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
      ],
    }));

    expect(normalized.agentId).toBe('com.acme.review/review-bot');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent',
      identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
    });
    expect(normalized.input.modelSelection?.ref).toMatchObject({
      agentTargetKey: 'agent:com.acme.review/review-bot',
      modelId: 'review-model',
    });
  });

  it('still rejects a qualified Agent key that no catalog Agent owns', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'agent:missing.acme.review/review-bot',
    }, createDeps())).rejects.toThrow(/--backend does not identify an executable Agent/);
  });

  it('normalizes explicit environment variables into the strict V2 Action input', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
    }, createDeps())).resolves.toMatchObject({
      input: {
        environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
      },
    });
  });

  it('rejects conflicting configuration aliases before Action dispatch', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'low' },
        },
      },
      configOptions: { reasoning_effort: 'high' },
    }, createDeps())).rejects.toThrow(/conflicts/);
  });
});
