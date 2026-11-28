import { expect, it } from 'vitest';
import type { AgentRuntime, AgentSessionModelsSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/compatibility/v1';
import type { Metadata } from '../../../../apps/cli/src/api/types';
import { createTestMetadata } from '../../../../apps/cli/src/testkit/backends/sessionMetadata';
import {
  createExternalContributionFixtures, createLease, createNativeAgentRuntimeSessionPlanFixture,
  createNativeSessionClientTestPort, createSessionHostServiceOwners,
} from '../../../../apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession.composed.testkit';
import { buildPluginSessionBindingInput } from '../../../../apps/cli/src/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createSessionRuntimeModelsPublisher } from '../../../../apps/cli/src/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { getModelOptionsForSession } from '../../../../apps/ui/sources/sync/domains/models/modelOptions';
import { buildSessionModelPickerSections } from '../../../../apps/ui/sources/components/sessions/modelPicker/buildSessionModelPickerSections';
import { createNativeAgentSessionPublications } from '../../../../apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withCodexNativeAttachFixture } from '../../../plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { buildCodexCloudAuthFile } from '../../../plugins/codex/src/agent/auth/services/openai/cloud/authFile';

it('keeps the accepted Direct Team Session on its execution-side model observation through the in-session picker', async () => {
  const agentId = 'acme-direct-models';
  const agentTargetKey = `backend:${agentId}`;
  const selected = { kind: 'team_credential_provider_model' as const, teamId: 'team', resourceId: 'direct-resource',
    expectedResourceRevision: 3, deliveryMode: 'direct' as const, agentTargetKey, modelId: 'gpt-6.1-sol' };
  let metadata: Metadata = createTestMetadata({ machineId: 'execution-machine',
    sessionModelsV1: { v: 1, agentId, updatedAt: 1, currentModelId: selected.modelId,
      availableModels: [{ id: selected.modelId, name: 'Declared Sol' }, { id: 'gpt-5.5', name: 'Static declaration' }] } });
  const session = createNativeSessionClientTestPort('direct-session', {
    getMetadataSnapshot: () => metadata,
    updateMetadataAsCurrentPublisher: async (update: (current: Metadata) => Metadata) => { metadata = update(metadata); },
  });
  let snapshot: AgentSessionModelsSnapshot = { observedAt: 2, currentModelId: selected.modelId,
    models: [{ id: selected.modelId, name: 'Observed Sol' }, { id: 'gpt-6.1-terra', name: 'Observed Terra' }] };
  const listeners = new Set<(value: AgentSessionModelsSnapshot) => void>();
  let preparations = 0;
  let opens = 0;
  const runtime: AgentRuntime = { sessions: { async open(request, context) {
    opens++;
    // The daemon credential preparation is a process boundary. The real Session
    // adapter must pass its accepted Direct binding into the native Agent before
    // that Agent can bind observations; no Machine-wide personal probe is used.
    expect(preparations).toBe(1);
    expect(request.providerBinding).toMatchObject({ source: { kind: 'team_resource', resourceId: selected.resourceId },
      model: { id: selected.modelId } });
    expect(request.launchEnvironment?.values.SOURCE_TOKEN).toBe('controlled-direct-token');
    context.session.services.models.bind({ read: () => snapshot,
      subscribe(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } });
    return { send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), async dispose() {} };
  } } };
  const contributions = createExternalContributionFixtures(agentId);
  const providerRequirements = {
    acceptsProtocols: ['openai-responses'],
    required: {},
    credentialSupport: { supportsNoAuth: false, apiKeyTransports: [{
      protocol: 'openai-responses', destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] },
    }] },
    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['SOURCE_TOKEN'] },
    materialization: 'spawnEnv',
    applyPolicy: 'restart_session',
    supportsFreeformModelIds: true,
  } satisfies AgentProviderRequirementsV1;
  const agent = { ...contributions.agent, richDefinition: { ...contributions.agent.richDefinition,
    definition: { ...contributions.agent.richDefinition.definition, providerRequirements } } };
  const plan = await createNativeAgentRuntimeSessionPlanFixture({ runtime, lease: createLease(agentId),
    backend: contributions.backend, agent, createSessionHostServiceOwners,
    prepareTeamCredentialProviderBinding: async request => {
      preparations++;
      expect(request).toMatchObject({ resourceId: selected.resourceId, modelId: selected.modelId });
      return { providerBinding: { source: { kind: 'team_resource', resourceId: selected.resourceId, resourceRevision: 3 },
        model: { id: selected.modelId, name: 'Declared Sol' },
        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://controlled-upstream.test/v1', credential: 'apiKey' },
        materialization: { v: 1, kind: 'spawnEnv' } },
        environmentOverlay: [{ name: 'SOURCE_TOKEN', value: 'controlled-direct-token', source: 'provider' }],
        additionalRedactionValues: ['controlled-direct-token'], cleanup() {} };
    },
    sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'fixture', encryption: null }, directory: '/fixture',
      backendTarget: { kind: 'backend', backendId: agentId },
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: selected.modelId } },
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: selected.resourceId,
        teamId: selected.teamId, expectedResourceRevision: 3, deliveryMode: 'direct' }] }),
  });
  // The canonical testkit supplies Session/OS ports; unrelated terminal/MCP
  // ports are not consumed by this finite open.
  const created = await plan.config.createSessionRuntime({ directory: '/fixture', metadata, machineId: 'execution-machine',
    session, transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
    getPermissionMode: () => 'default', setThinking() {}, memoryRecallGuidanceEnabled: false } as never);
  const source = created.nativeRuntime?.models;
  if (!source) throw new Error('Accepted native Session model source is missing');
  const publisher = createSessionRuntimeModelsPublisher({ agentId, agentTargetKey,
    runnerProcessIdentity: { pid: 123, processStartTimeMs: 1 }, session: { ...session, getMetadataSnapshot: () => metadata,
      updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } }, source,
    readAppliedTeamCredentialModel: created.nativeRuntime?.readAppliedTeamCredentialModel });
  const pickerIds = () => buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey,
    nativeModels: getModelOptionsForSession(agentId, metadata), providerGroups: [], hiddenNativeModelKeys: new Set(),
    providerProjectionAuthoritative: true }).flatMap(section => section.options)
    .flatMap(option => option.value && 'modelId' in option.value ? [option.value.modelId] : []);
  try {
    await publisher.flush();
    expect(created.nativeRuntime?.readAppliedTeamCredentialModel?.()).toEqual(selected);
    expect(pickerIds()).toEqual(['default', 'gpt-6.1-sol', 'gpt-6.1-terra']);
    expect(metadata.sessionModelsV1?.availableModels.map(model => model.id)).not.toContain('gpt-5.5');
    snapshot = { observedAt: 3, currentModelId: selected.modelId, models: [{ id: selected.modelId, name: 'Observed Sol' }] };
    for (const listener of listeners) listener(snapshot);
    await publisher.flush();
    expect(pickerIds()).toEqual(['default', 'gpt-6.1-sol']);
    snapshot = { observedAt: 4, currentModelId: selected.modelId, models: [] };
    for (const listener of listeners) listener(snapshot);
    await publisher.flush();
    expect(pickerIds()).toEqual(['default']);
    expect(preparations).toBe(1);
    expect(opens).toBe(1);
  } finally {
    await publisher.stopAndDrain();
    await created.operations.resetOrDisposeRuntime();
  }
  expect(listeners.size).toBe(0);
});

it.skipIf(process.platform === 'win32')('publishes the real Codex catalog from the accepted execution-side Account, not the Team declaration', async () => {
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  let metadata: Metadata = createTestMetadata({ machineId: 'execution-machine', sessionModelsV1: {
    v: 1, agentId: 'codex', updatedAt: 1, currentModelId: 'fixture-model',
    availableModels: [{ id: 'gpt-5.5', name: 'Static Team declaration' }],
  } });
  const session = { getMetadataSnapshot: () => metadata,
    async updateMetadataAsCurrentPublisher(update: (current: Metadata) => Metadata) { metadata = update(metadata); },
    on() {}, off() {}, updateAgentState() {} };
  const controller = new AbortController();
  const publications = createNativeAgentSessionPublications({ agentId: 'codex', session,
    signal: controller.signal, isCurrent: () => true, supportsInFlightSteer: false });
  const publisher = createSessionRuntimeModelsPublisher({ agentId: 'codex', session, source: publications.modelsSource });
  // Direct admission/materialization has already happened. This is the native
  // home's OS boundary, carrying the accepted Account's bytes; no saved personal
  // account, Team browse or broker allowance is consulted by this Session owner.
  const authBytes = new TextEncoder().encode(JSON.stringify(buildCodexCloudAuthFile({
    accessToken: 'controlled-direct-access', idToken: null, accountId: 'direct-source-account',
    lastRefreshIso: '2026-10-28T00:00:00.000Z',
  })));
  try {
    await withCodexNativeAttachFixture(async fixture => {
      await fixture.openConfiguredSession();
      await publisher.flush();
      expect(fixture.requests.find(request => request.method === 'account/login/start')?.params)
        .toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'direct-source-account' });
      expect(fixture.requests.filter(request => request.method === 'model/list')).toHaveLength(1);
      expect(getModelOptionsForSession('codex', metadata).filter(option => option.value !== 'default').map(option => option.value))
        .toEqual(['gpt-6.1-sol', 'gpt-6.1-terra']);
    }, {
      models: publications.services.models,
      sessionConnectedAccounts: [{ purpose: 'primary', account: { service, accountId: 'delivered-account' } }],
      processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: `${service.pluginId}/${service.localId}`, profileId: 'delivered-account' },
      ]) },
      runtimeAuthHost: { nativeHome: { readFiles: async () => ({ 'auth.json': authBytes }) } },
      modelListResponse: { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Observed Sol' },
        { id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', displayName: 'Observed Terra' }], nextCursor: null },
    });
  } finally {
    await publisher.stopAndDrain();
    controller.abort();
    publications.dispose();
  }
});
