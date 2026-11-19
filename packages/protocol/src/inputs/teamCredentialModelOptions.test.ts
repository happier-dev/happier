import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { resolveMachineAgentTeamCredentialDemandV1 } from '../teams/credentials/teamCredentialModelCatalogV1.js';
import { openPrivateLabelV1 } from '../crypto/privateLabelV1.js';
import { NO_TEAM_CAPABILITIES_V1 } from '../teams/capabilities.js';

const TEAM = { id: 'team-1', name: 'Team', description: null, logo: null,
  archivedAt: null, recovery: null, viewerRole: 'member', capabilities: NO_TEAM_CAPABILITIES_V1,
  counts: null, admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
  policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
    defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null } };

const CODEX = 'agent:happier.agent.codex/codex';
const BROKER = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
const APPLICATION = { agentTargetKey: CODEX, implementationIdentity: BROKER, endpointTemplateId: 'responses', protocol: 'openai-responses' };

const projection = {
  agentsById: {
    codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      providerRequirements: { acceptsProtocols: ['openai-responses'] },
      connectedAccounts: [{ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }] },
  },
  familiesById: { providers: { entriesById: {
    'happier.provider.cliproxyapi/cliproxyapi': { id: 'happier.provider.cliproxyapi/cliproxyapi', provenance: 'first_party',
      definition: { endpointTemplates: [{ id: 'responses', protocol: 'openai-responses' }, { id: 'chat', protocol: 'openai-chat' }],
        managedRuntime: { endpointTemplateIds: ['responses', 'chat'] } } },
  } } },
} as any;

const resource = (id: string, service: { pluginId: string; localId: string }, availability = 'available') => ({
  id, teamId: 'team-1', displayName: { content: { t: 'plain', v: `${id} account` }, recipientEnvelope: null }, resourceRevision: 1, sourceOwnerDisplayName: 'Ada',
  readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
  directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
  sourcePresentation: { kind: 'connected_service', service },
  providerModels: [{ selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: id,
    expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: CODEX, modelId: `${id}-model` },
  descriptor: { id: `${id}-model`, name: `${id} model` }, application: APPLICATION, sourceRevision: 'source-1', availability }],
});

describe('teams.credential_models.available', () => {
  it('derives the broker applications an Agent accepts on the Machine from its projection', () => {
    const demand = resolveMachineAgentTeamCredentialDemandV1(projection, CODEX);
    expect(demand).toMatchObject({ requirements: { acceptsProtocols: ['openai-responses'] }, applications: [APPLICATION],
      connectedServiceKeys: ['happier.agent.codex/openai-codex'] });
    expect(resolveMachineAgentTeamCredentialDemandV1(projection, 'agent:happier.agent.claude/claude'))
      .toEqual({ requirements: null, applications: [], connectedServiceKeys: null });
  });

  it.each([
    ['Musee model', true],
    ['unrelated model', false],
  ] as const)('resolves spoken spawn model %s from a single field', async (query, matches) => {
    const muse = resource('muse', { pluginId: 'happier.agent.muse', localId: 'muse-account' });
    const ref = { source: 'team_resource', teamId: 'team-1', resourceId: 'muse', expectedResourceRevision: 1,
      deliveryMode: 'brokered', agentTargetKey: CODEX, modelId: 'muse-model' };
    const result = await createActionExecutor({
      agentsModelsList: async () => ({ items: [{ id: 'native', name: 'Native' }], source: 'dynamic' }),
      resolveSessionSpawnAgentInventorySelection: async () => ({ backendTargetKey: CODEX }),
      machinePluginProjectionRead: async () => projection,
      homeDomainAction: async ({ actionId }) => actionId === 'teams.list'
        ? { items: [TEAM], nextCursor: null } : { resources: [muse], nextCursor: null, failures: [] },
      providerActionExecute: async () => ({ ok: true, result: { status: 'success', agentTargetKey: CODEX, groups: [],
        teamCredentialResources: [muse] } }),
    }).execute('action.options.resolve', {
      actionId: 'session.spawn_new', fieldPath: 'modelSelection', query,
      draftInput: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        executionTarget: { serverId: 'home', machineId: 'm1' } },
    }, { surface: 'voice', authority: 'present_user', serverId: 'home' });
    if (matches) {
      expect(result).toMatchObject({ ok: true, result: { options: [{ value: ref }] } });
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_model_not_found',
        details: { candidates: expect.arrayContaining([expect.objectContaining({ value: ref })]) } });
    }
  });

  it('offers the Team credential models the Session Machine can run for the selected Agent', async () => {
    const homeCalls: unknown[] = [];
    const homeDomainAction = vi.fn(async ({ actionId, input }: { actionId: string; input: unknown }) => {
      homeCalls.push([actionId, input]);
      if (actionId === 'teams.list') return { items: [TEAM], nextCursor: null };
      return { resources: [
        resource('codex', { pluginId: 'happier.agent.codex', localId: 'openai-codex' }),
        resource('muse', { pluginId: 'happier.agent.muse', localId: 'muse-account' }),
        { ...resource('other-endpoint', { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }),
          providerModels: resource('other-endpoint', { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }).providerModels
            .map(model => ({ ...model, application: { ...APPLICATION, endpointTemplateId: 'not-supported' } })) },
      ], nextCursor: null, failures: [] };
    });
    const providerActionExecute = vi.fn(async (request: any) => ({ ok: true as const, result: { status: 'success', agentTargetKey: CODEX, groups: [],
      teamCredentialResources: request.input.teamCredentialResources } }));
    const deps = { privateLabelOpen: async (request: Parameters<NonNullable<ActionExecutorDeps['privateLabelOpen']>>[0]) => openPrivateLabelV1(request), machinePluginProjectionRead: vi.fn(async () => projection), homeDomainAction, providerActionExecute } as unknown as ActionExecutorDeps;
    const result = await createActionExecutor(deps).execute('action.options.resolve', {
      actionId: 'subagents.delegate.start', fieldPath: 'teamCredentialModel', sessionId: 's1',
      draftInput: { backendTargetKeys: [CODEX] },
    }, { surface: 'ui', authority: 'present_user', defaultSessionMachineId: 'm1' });

    expect(result).toMatchObject({ ok: true });
    const options = (result as any).result.options;
    expect(options.map((option: any) => [option.label, option.disabled === true])).toEqual([['codex model', false], ['muse model', false]]);
    expect(JSON.parse(options[0].value)).toMatchObject({ kind: 'team_credential_provider_model', resourceId: 'codex', modelId: 'codex-model' });
    expect(homeCalls.filter(([id]: any) => id === 'teams.credentials.entitled.list'))
      .toEqual([['teams.credentials.entitled.list', { teamIds: ['team-1'], application: APPLICATION, executionMachineId: 'm1' }]]);
    expect(providerActionExecute.mock.calls[0]?.[0]).toMatchObject({ actionId: 'providers.models.projection',
      input: { machineId: 'm1', agentTargetKey: CODEX } });
  });
});
