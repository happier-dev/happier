import { describe, expect, it, vi } from 'vitest';

import { matchSpokenSpawnModelOptions, projectSpokenSpawnModelChoices } from './inputOptions.js';
import { decodeVoiceAssistantActions } from '../voice/actions.js';
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

  function spokenCatalog(versions: readonly string[]) {
    const muse = resource('muse', { pluginId: 'happier.agent.muse', localId: 'muse-account' });
    const modelId = (version: string) => version ? `muse-spark-${version}` : 'muse-model';
    const ref = (version: string) => ({ source: 'team_resource', teamId: 'team-1', resourceId: 'muse', expectedResourceRevision: 1,
      deliveryMode: 'brokered', agentTargetKey: CODEX, modelId: modelId(version) });
    const [model] = muse.providerModels;
    muse.providerModels = versions.map(version => ({ ...model,
      selection: { ...model.selection, modelId: modelId(version) },
      descriptor: { id: modelId(version), name: version ? `Muse Spark ${version}` : 'Muse model' },
    }));
    const births: unknown[] = [];
    const executor = createActionExecutor({
      sessionSpawnNew: async request => { births.push(request.admittedInput);
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }; },
      agentsModelsList: async () => ({ items: [{ id: 'native', name: 'Native' }], source: 'dynamic' }),
      resolveSessionSpawnAgentInventorySelection: async () => ({ backendTargetKey: CODEX }),
      machinePluginProjectionRead: async () => projection,
      homeDomainAction: async ({ actionId }) => actionId === 'teams.list'
        ? { items: [TEAM], nextCursor: null } : { resources: [muse], nextCursor: null, failures: [] },
      providerActionExecute: async () => ({ ok: true, result: { status: 'success', agentTargetKey: CODEX, groups: [],
        teamCredentialResources: [muse] } }),
    });
    return { executor, births, ref };
  }

  const spokenSpawnInput = {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    executionTarget: { serverId: 'home', machineId: 'm1' },
    directory: { kind: 'managed' },
    initialInput: { text: 'Write exactly yellow to the requested file.' },
  } as const;
  const spokenSpawnContext = { surface: 'voice', authority: 'present_user', serverId: 'home', actionRequestId: 'spoken-model-request' } as const;

  it('round-trips all three source-qualified labels to their original model selections', () => {
    const label = 'Shared Model';
    const options = [
      { label, value: 'native-model' },
      { label, value: { agentTargetKey: CODEX, providerConnectionId: 'personal-connection', modelId: 'personal-model' } },
      { label, value: { source: 'team_resource', teamId: 'team-1', resourceId: 'credential', expectedResourceRevision: 1,
        deliveryMode: 'brokered', agentTargetKey: CODEX, modelId: 'team-model' } },
    ];
    const choices = projectSpokenSpawnModelChoices(options);
    expect(choices).toEqual([{ label: 'Shared Model Native' }, { label: 'Shared Model Personal' }, { label: 'Shared Model Team' }]);
    expect(choices.map(choice => matchSpokenSpawnModelOptions(options, choice.label))).toEqual(options.map(option => [option]));
  });

  it('admits two Team credential resources for the same spoken model label and refuses to guess', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const resources = ['first', 'second'].map(id => {
      const item = resource(id, service);
      const [model] = item.providerModels;
      return { ...item, providerModels: [{ ...model,
        descriptor: { id: 'shared-model', name: 'Shared Model' },
        selection: { ...model.selection, modelId: 'shared-model' },
      }] };
    });
    const spawn = vi.fn<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>(async () => ({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }));
    const executor = createActionExecutor({
      sessionSpawnNew: spawn,
      agentsModelsList: async () => ({ items: [{ id: 'native-shared-id', label: 'Shared Model' }, { id: 'other-id', label: 'Other Model' }], source: 'dynamic' }),
      resolveSessionSpawnAgentInventorySelection: async () => ({ backendTargetKey: CODEX }),
      machinePluginProjectionRead: async () => projection,
      homeDomainAction: async ({ actionId }) => actionId === 'teams.list'
        ? { items: [TEAM], nextCursor: null } : { resources, nextCursor: null, failures: [] },
      providerActionExecute: async () => ({ ok: true, result: { status: 'success', agentTargetKey: CODEX, groups: [],
        teamCredentialResources: resources } }),
    });
    const candidates = resources.map(item => ({ label: 'Shared Model', value: {
      source: 'team_resource', resourceId: item.id, teamId: item.teamId, modelId: 'shared-model',
    } }));
    const run = (spokenModelName: string) => executor.execute('session.spawn_new',
      { ...spokenSpawnInput, spokenModelName }, spokenSpawnContext);
    expect(await run('Shared Model')).toMatchObject({
      ok: false, errorCode: 'provider_model_ambiguous', details: { candidates: expect.arrayContaining([...candidates.map(candidate => expect.objectContaining({
        ...candidate, value: expect.objectContaining(candidate.value),
      })), { label: 'Other Model', value: 'other-id' }]) },
    });
    expect(await run('Shared Model Team')).toMatchObject({
      ok: false, errorCode: 'provider_model_ambiguous', details: { candidates: expect.arrayContaining([...candidates.map(candidate => expect.objectContaining({
        ...candidate, value: expect.objectContaining(candidate.value),
      })), { label: 'Other Model', value: 'other-id' }]) },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(await run('Shared Model Native')).toMatchObject({ ok: true });
    expect(spawn.mock.calls[0]?.[0].admittedInput).toMatchObject({
      modelSelection: { ref: { providerConnectionId: null, modelId: 'native-shared-id' } },
    });
  });

  it.each([
    { query: 'Muse Spark 1.2', versions: ['1.2', '1.2.3'], matched: '1.2', errorCode: null },
    { query: 'Muse Spark', versions: ['1.2', '1.3'], matched: null, errorCode: 'provider_model_ambiguous' },
    { query: 'Muse Spark 1.2', versions: ['1.2.3'], matched: null, errorCode: 'provider_model_not_found' },
  ])('spawns a Voice child only after the spoken model "$query" resolves uniquely ($errorCode)', async ({ query, versions, matched, errorCode }) => {
    const { executor, births, ref } = spokenCatalog(versions);
    const decoded = decodeVoiceAssistantActions([{ t: 'spawnSession', args: { ...spokenSpawnInput, spokenModelName: query } }]);
    expect(decoded.actions).toHaveLength(1);
    const result = await executor.execute('session.spawn_new', decoded.actions[0]!.args, spokenSpawnContext);

    if (matched) {
      expect(result).toMatchObject({ ok: true, result: { type: 'pending' } });
      expect(births).toMatchObject([{ modelSelection: { v: 2, ref: ref(matched), updatedAt: expect.any(Number) } }]);
      expect(births[0]).not.toHaveProperty('spokenModelName');
    } else {
      expect(result).toMatchObject({ ok: false, errorCode,
        details: { candidates: expect.arrayContaining(versions.map(version => expect.objectContaining({ value: ref(version) }))) } });
      expect(births).toEqual([]);
    }
  });

  it.each([
    { query: 'Musee model', versions: [''], matches: [''] },
    { query: 'unrelated model', versions: [''], matches: [] },
    { query: 'muse-spark-1.2', versions: ['1.2.3'], matches: [] },
    { query: 'muse-spark-1.2', versions: ['1.2', '1.2.3'], matches: ['1.2'] },
    { query: 'muse spark', versions: ['1.2', '1.3'], matches: ['1.2', '1.3'] },
    { query: 'muse-spark-1.2.3', versions: ['1.2'], matches: [] },
    { query: '1.2', versions: ['0.1.2'], matches: [] },
  ])('resolves spoken spawn model "$query" with versions $versions', async ({ query, versions, matches }) => {
    const { executor, ref } = spokenCatalog(versions);
    const result = await executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new', fieldPath: 'modelSelection', query, draftInput: spokenSpawnInput,
    }, spokenSpawnContext);
    if (matches.length > 0) {
      expect(result).toMatchObject({ ok: true, result: { options: matches.map(version => ({ value: ref(version) })) } });
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_model_not_found',
        details: { candidates: expect.arrayContaining(versions.map(version => expect.objectContaining({ value: ref(version) }))) } });
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
