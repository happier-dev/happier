import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Real UI Sync/storage needs the owning harness's native platform boundaries.
import '../../../../ui/sources/dev/vitestSetup';

import { AgentStateSchema } from '@happier-dev/session-core/state';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CurrentSessionPresentationBindResultV1Schema,
  CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub, createSessionTurnMutationAppliedSocketAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { parsePlainSessionAgentState } from '../../../../ui/sources/sync/engine/sessions/parsePlainSessionPayload';
import { buildUpdatedSessionFromSocketUpdate } from '../../../../ui/sources/sync/engine/sessions/syncSessions';
import { fetchAndApplySessionById } from '../../../../ui/sources/sync/engine/sessions/sessionById';
import { storage as uiStorage } from '../../../../ui/sources/sync/domains/state/storageStore';
import { SessionEncryption } from '../../../../ui/sources/sync/encryption/sessionEncryption';
import { SecretBoxEncryption } from '../../../../ui/sources/sync/encryption/encryptor';
import { EncryptionCache } from '../../../../ui/sources/sync/encryption/encryptionCache';
import { applyCurrentSessionPresentationCommand } from '../../../../ui/sources/components/sessions/presentation/applyCurrentSessionPresentationCommand';
import { createNativeAgentRuntimeSessionPlan } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { createExternalContributionFixtures, createLease, createNativeAgentLaunchPreparationFixture } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCustomAcpAgentRuntime } from '../../../../../packages/plugins/custom-acp/src/agent/runtime/factory';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveEffectiveCodingPromptPlan } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { AgentSessionStartupInstructionsV1Schema, FeaturesResponseSchema, PluginAgentContributionV2Schema, SessionTurnMutationV1Schema, UpdateBodySchema, type AgentSessionRuntimeEvent } from '@happier-dev/protocol';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntimeDaemonSessionOpenRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCurrentSessionPresentationHost } from './currentSessionPresentationService';

const boundary = vi.hoisted(() => ({ io: vi.fn(), fetch: vi.fn(), patch: vi.fn() }));
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) =>
    typeof args[0] === 'string' && args[0].startsWith('http://127.0.0.1:')
      ? actual.io(...args) : boundary.io(...args) };
});
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: boundary.fetch,
  patchSessionMetadataEnvelopeTuple: boundary.patch,
}));

describe('current-session presentation publication composition', () => {
  const clients = new Set<ApiSessionClient>();
  const controllers = new Set<AbortController>();
  const runtimeDisposals = new Set<() => Promise<void>>();
  beforeEach(() => {
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'presentation-machine' });
    const transcript = createSessionTranscriptHomeStub();
    const answer = (event: string, payload: unknown) => {
      return activity.answer(event, payload)
      ?? transcript.answer(event, payload)
      ?? (event === 'session-turn-mutation'
        ? createSessionTurnMutationAppliedSocketAck(SessionTurnMutationV1Schema.parse(payload))
        : { ok: true, result: 'success', version: 1 });
    };
    boundary.io.mockReset().mockImplementation(() => createApiSessionSocketStub({ connected: true,
      emitWithAck: answer,
      emit: (event, args) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(answer(event, args[0]));
      },
    }));
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
      session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 },
        publisherAuthority: { protocolVersion: 1 } },
    } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.startsWith('/v1/features')) return Response.json(features);
      throw new Error(`Unexpected Home fetch ${path}`);
    }));
    boundary.fetch.mockReset();
    boundary.patch.mockReset();
  });
  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    // Stop the real transport before disposing its native provider process.
    const closeResults = await Promise.allSettled([...clients].map((client) => client.close()));
    const disposeResults = await Promise.allSettled([...runtimeDisposals].map((dispose) => dispose()));
    runtimeDisposals.clear();
    clients.clear();
    controllers.clear();
    vi.unstubAllGlobals();
    const errors = [...closeResults, ...disposeResults]
      .flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'Composed native Session cleanup failed');
  });

  it('keeps the focused client binding through native conversation replacement and real Action publication/ACK', async () => {
    await withTempDir('happier-presentation-composed-', async (directory) => {
    const session = createPlainSessionFixture({ id: 'presentation-composed', metadataLayoutVersion: 1 });
    let stored = {
      ...createSessionNotificationContextFixture(session.id),
      ...session,
      metadata: JSON.stringify({ v: 1, machineId: 'presentation-machine' }),
      ownerMetadata: { t: 'plain' as const, v: { v: 1 as const } },
      agentState: null as string | null,
      dataEncryptionKey: null,
      share: null,
    };
    boundary.fetch.mockImplementation(async () => stored);
    // Only HTTP persistence is replaced. The API client, tuple serializer,
    // presentation registrations, UI hydration and ACK dispatcher remain real.
    boundary.patch.mockImplementation(async ({ patch: input }: Parameters<
      typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple
    >[0]) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'owner' || patch.ownerMetadata.t !== 'plain') throw new Error('Expected the plain owner tuple');
      stored = {
        ...stored,
        metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: patch.sharedMetadata.expectedVersion + 1,
        ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext,
        agentStateVersion: patch.agentState.expectedVersion + 1,
      };
      return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: stored.metadataVersion }, agentState: { version: stored.agentStateVersion } });
    });
    const client = createTestApiSessionClient(ApiSessionClient, 'owner-token', session, {
      metadataAuthority: { kind: 'owner', credentials: { token: 'owner-token', encryption: null } },
      getAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture(),
    });
    clients.add(client);
    const initialHydration = await fetchAndApplySessionById({
      sessionId: session.id, credentials: { token: 'owner-token' },
      accountCurrentness: createAccountEncryptionCurrentnessFixture(),
      encryption: { decryptEncryptionKey: async () => null, initializeSessions: async () => {}, getSessionEncryption: () => null },
      sessionDataKeys: new Map(), request: async () => Response.json({ session: V2SessionRecordSchema.parse(stored) }),
      applySessions: sessions => uiStorage.getState().applySessions(sessions), log: { log: () => {} },
    });
    expect(initialHydration, JSON.stringify(initialHydration)).toMatchObject({ ok: true });
    if (!initialHydration.ok || !initialHydration.session) throw new Error('Owner UI Session did not hydrate');
    expect(initialHydration.session).toMatchObject({ metadataLayoutVersion: 1,
      access: { role: 'owner' }, ownerMetadataView: expect.any(Object), encryptedContentAvailability: 'ready' });
    const hydrateSocketState = async () => {
      const uiSession = uiStorage.getState().sessions[session.id];
      if (!uiSession) throw new Error('Owner Session absent from UI storage');
      const update = await buildUpdatedSessionFromSocketUpdate({
        session: uiSession,
        updateBody: UpdateBodySchema.parse({ t: 'update-session', id: session.id, metadataLayoutVersion: stored.metadataLayoutVersion,
          metadata: { version: stored.metadataVersion, value: stored.metadata },
          agentState: { version: stored.agentStateVersion, value: stored.agentState } }),
        updateSeq: stored.agentStateVersion, updateCreatedAt: stored.updatedAt, sessionEncryption: null,
      });
      uiStorage.getState().applySessions([update.nextSession]);
      return uiStorage.getState().sessions[session.id]?.agentState;
    };
    const metadata = client.getMetadataSnapshot();
    if (!metadata) throw new Error('Composed native Session metadata unavailable');
    const controller = new AbortController();
    controllers.add(controller);
    const presentationHost = createCurrentSessionPresentationHost({ session: client, signal: controller.signal });
    const agentId = 'acme-presentation-composed';
    const contributionFixtures = createExternalContributionFixtures(agentId);
    const contributions = {
      ...contributionFixtures,
      agent: { ...contributionFixtures.agent, richDefinition: {
        ...contributionFixtures.agent.richDefinition,
        definition: PluginAgentContributionV2Schema.parse({ ...contributionFixtures.agent.richDefinition.definition, capabilities: {
          ...contributionFixtures.agent.richDefinition.definition.capabilities,
          sessions: { ...contributionFixtures.agent.richDefinition.definition.capabilities.sessions,
            startupInstructions: { versions: [1], revisionChanges: 'resume' },
          },
        } }),
      } },
    };
    const identity = createLease(agentId);
    const credentials = { token: 'owner-token', encryption: null };
    const admittedOpenRequests: unknown[] = [];
    // Only the vendor executable is a fixture. The production ACP runtime,
    // native host, conversation replacement, Session services and registrations remain real.
    const processRecord = join(directory, 'vendor-methods.jsonl');
    const executable = writeAcpTestAgentScript({ dir: directory, fileName: 'presentation-agent.mjs', source: `
      import { appendFileSync } from 'node:fs';
      let buffer = '';
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      process.stdin.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          appendFileSync(${JSON.stringify(processRecord)}, JSON.stringify({ method: message.method, pid: process.pid }) + '\\n');
          let result = {};
          if (message.method === 'initialize') result = { protocolVersion: 1,
            agentInfo: { name: 'presentation-fixture', version: '1.0.0' },
            agentCapabilities: { loadSession: true } };
          if (message.method === 'session/new') result = { sessionId: 'native-presentation-conversation' };
          if (message.method === 'session/prompt') {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ready' } } } });
            result = { stopReason: 'end_turn' };
          }
          send({ jsonrpc: '2.0', id: message.id, result });
        }
      });
    ` });
    const permissionHandler = new ProviderEnforcedPermissionHandler(client, { logPrefix: '[PresentationTest]' });
    const launchPreparation = await createNativeAgentLaunchPreparationFixture();
    const plan = await createNativeAgentRuntimeSessionPlan({
      runtime: createCustomAcpAgentRuntime(),
      identity,
      ...contributions,
      generationSignal: controller.signal,
      sessionInput: buildPluginSessionBindingInput({
        credentials, directory,
        backendTarget: { kind: 'backend', backendId: agentId },
      }),
      resolveAcpHostLaunch: async () => ({ command: process.execPath, args: [executable], env: {}, unsetEnv: [], timeouts: {} }),
      createInvocationServices: async ({ signal }) => ({ ...createUnavailablePluginServices(),
        exec: createStablePluginExecService({  signal,
          isOccurrenceCurrent: () => !controller.signal.aborted,
          resolveExecutable: async () => { throw new Error('The host-owned ACP fixture already resolved its executable'); },
          resolvePath: async () => directory,
          prepareAgentNativeLaunch: launchPreparation.prepare(directory, signal),
        }),
      }),
      attestSessionOpen: async ({ phase, request }) => {
        const admitted = AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request);
        if (phase === 'commit') admittedOpenRequests.push(admitted);
      },
      createSessionHostServiceOwners: ({ hostRuntimeParams, ...scope }) => createNativeAgentSessionHostServiceOwners({
        runtimeRegistry: null, identity, ...contributions, ...scope,
        hostSession: hostRuntimeParams,
      }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Native Session factory unavailable');
    const created = await plan.config.createSessionRuntime({
      directory, metadata,
      machineId: 'presentation-machine', agentTargetKey: agentId,
      session: client, transcriptSession: client, messageBuffer: new MessageBuffer(),
      currentSessionPresentation: presentationHost.bindCurrentSession,
      mcpServers: {}, permissionHandler,
      getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
      runnerProcessIdentity: null, startupModelSelection: null,
      runWithTerminalModelSelection: async (effect) => ({ status: 'completed', value: await effect(null,
        async (localEffect) => ({ status: 'completed', value: await localEffect() })) }),
    });
    runtimeDisposals.add(async () => { await created.operations.resetOrDisposeRuntime(); });
    const nativeEvents: AgentSessionRuntimeEvent[] = [];
    const unsubscribeRuntimeEvents = created.operations.subscribeRuntimeEvents(event => {
      nativeEvents.push(event);
    });
    runtimeDisposals.add(async () => { unsubscribeRuntimeEvents(); });
    const { executor } = createCliActionExecutorHarness({ token: 'owner-token', sessionId: session.id, mode: 'plain', ctx: null });
    const apply = (operationId: string) => executor.execute('session.presentation.apply',
      { intent: { kind: 'viewer.open', source: 'computer' } },
      { surface: 'agent', authority: 'account_automation', defaultSessionId: session.id, actionRequestId: operationId });
    expect(ActionExecuteFailureSchema.parse(await apply('unbound-agent-call'))).toMatchObject({
      ok: false,
      errorCode: 'current_session_presentation_not_current',
      details: {
        stage: 'before_publication', reason: 'client_not_bound', hostNonce: expect.any(String), revision: 0,
      },
    });
    const origin = { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
      sessionId: session.id, accountId: 'owner-account', connectionId: 'viewer-socket' } as const;
    const call = (method: string, params: unknown) => client.rpcHandlerManager.handleRequest({
      method: `${session.id}:${method}`, params, authorization: origin,
    });
    const patchesBeforeBind = boundary.patch.mock.calls.length;
    const bindings = await Promise.all(Array.from({ length: 3 }, async () =>
      CurrentSessionPresentationBindResultV1Schema.parse(await call(
        CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, { clientId: 'viewer-client', focused: true, draftRevision: 0 },
      ))));
    const bound = bindings[0]!;
    expect(bindings).toEqual([bound, bound, bound]);
    expect(boundary.patch.mock.calls.length - patchesBeforeBind).toBe(1);
    expect(bound.status).toBe('bound');
    if (bound.status !== 'bound') throw new Error('Viewer did not bind');
    expect(parsePlainSessionAgentState(stored.agentState)).toHaveProperty(CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY);

    // This is the production replacement primitive used by the first-turn
    // prompt-plan path. Replace the native incarnation, not the logical Session.
    const preparedPlan = await resolveEffectiveCodingPromptPlan({
      toolDelivery: 'unsupported', settings: {}, profileId: null,
      baseOverride: 'Prepared native Session instructions', memoryRecallGuidanceEnabled: false,
      sessionTitleToolAvailable: false,
    });
    await vi.waitFor(() => expect(created.operations.readSessionIdentity().sessionId).toBeTypeOf('string'));
    const providerSessionId = created.operations.readSessionIdentity().sessionId;
    if (!providerSessionId) throw new Error('Native conversation identity unavailable');
    await created.operations.resetOrDisposeRuntime('session_closed', {
      kind: 'resume', providerSessionId, importHistory: false,
      startupInstructions: AgentSessionStartupInstructionsV1Schema.parse({
        v: 1, id: 'happier.coding_session_plan', revision: 1, instructions: preparedPlan.text,
      }),
    });
    expect(created.operations.readSessionStartupInstructions?.()?.instructions).toBe(preparedPlan.text);
    expect(admittedOpenRequests).toMatchObject([
      { kind: 'create' },
      { kind: 'resume', startupInstructions: { instructions: preparedPlan.text } },
    ]);
    const vendorMethods = (await readFile(processRecord, 'utf8')).trim().split('\n').map(line => {
      const record: unknown = JSON.parse(line);
      return record && typeof record === 'object' && 'method' in record ? record.method : null;
    });
    expect(vendorMethods.filter(method => method === 'session/new' || method === 'session/load'))
      .toEqual(['session/new', 'session/load']);
    expect(nativeEvents).toContainEqual(expect.objectContaining({ kind: 'provider-session-id' }));

    const pending = apply('agent-computer-open');
    let settledAction: Awaited<typeof pending> | undefined;
    void pending.then(result => { settledAction = result; });
    await vi.waitFor(() => {
      if (settledAction && !settledAction.ok) expect(settledAction, JSON.stringify(settledAction)).toMatchObject({ ok: true });
      expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command)
        .toMatchObject({ id: 'agent-computer-open', kind: 'presentation.apply', clientId: 'viewer-client', intent: { kind: 'viewer.open', source: 'computer' } });
    });
    const hydrated = await hydrateSocketState();
    expect(hydrated).not.toBeNull();
    const state = CurrentSessionPresentationStateV1Schema.parse(hydrated?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]);
    expect(state.hostNonce).toBe(bound.hostNonce);
    const { [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: omittedPresentation, ...withoutPresentation } = hydrated!;
    expect(omittedPresentation).toBeDefined();
    expect(CurrentSessionPresentationStateV1Schema.safeParse(
      AgentStateSchema.parse(withoutPresentation)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    ).success).toBe(false);
    // The encrypted client consumes the same producer through the real socket
    // hydrator, rather than bypassing its layout/owner decision at decryptAgentState.
    const key = new Uint8Array(32).fill(7);
    const encryptedReader = new SessionEncryption(session.id, new SecretBoxEncryption(key), new EncryptionCache());
    const encryptedUpdate = await buildUpdatedSessionFromSocketUpdate({
      session: { ...initialHydration.session, encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' },
      updateBody: { agentState: { version: stored.agentStateVersion,
        value: encodeBase64(encrypt(key, 'legacy', JSON.parse(stored.agentState!))) } },
      updateSeq: stored.agentStateVersion, updateCreatedAt: stored.updatedAt, sessionEncryption: encryptedReader,
    });
    expect(encryptedUpdate.agentState?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]).toEqual(state);
    expect(AgentStateSchema.safeParse({ ...hydrated, [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: { ...state, revision: -1 } }).success)
      .toBe(false);
    const appliedIntents: unknown[] = [];
    expect(applyCurrentSessionPresentationCommand({
      state, hostNonce: bound.hostNonce, clientId: 'another-client', isCurrentSession: true,
      notify: () => {}, composer: null,
      presentation: { apply: (intent) => { appliedIntents.push(intent); return { status: 'applied' }; } },
    })).toBeNull();
    expect(appliedIntents).toEqual([]);
    const application = applyCurrentSessionPresentationCommand({
      state, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: true,
      notify: () => {}, composer: null,
      presentation: { apply: (intent) => { appliedIntents.push(intent); return { status: 'applied' }; } },
    });
    expect(appliedIntents).toEqual([{ kind: 'viewer.open', source: 'computer' }]);
    expect(application?.ack).toBeDefined();
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, application!.ack)).toEqual({ status: 'accepted' });
    expect(await pending).toEqual({ ok: true, result: { status: 'applied', revision: `${bound.hostNonce}:${state.revision}` } });
    expect(CurrentSessionPresentationStateV1Schema.parse(
      (await hydrateSocketState())?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    ).command).toBeUndefined();

    const uiPending = call(CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, { intent: { kind: 'viewer.open', source: 'computer' } });
    await vi.waitFor(() => expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command?.kind)
      .toBe('presentation.apply'));
    const uiState = CurrentSessionPresentationStateV1Schema.parse(
      (await hydrateSocketState())?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    );
    const uiApplication = applyCurrentSessionPresentationCommand({
      state: uiState, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: true,
      notify: () => {}, composer: null, presentation: { apply: () => ({ status: 'applied' }) },
    });
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, uiApplication!.ack)).toEqual({ status: 'accepted' });
    expect(await uiPending).toEqual({ status: 'applied', revision: `${bound.hostNonce}:${uiState.revision}` });

    const notCurrent = apply('agent-no-longer-current');
    await vi.waitFor(() => expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command?.id)
      .toBe('agent-no-longer-current'));
    const rejectedState = CurrentSessionPresentationStateV1Schema.parse(
      (await hydrateSocketState())?.[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    );
    const rejection = applyCurrentSessionPresentationCommand({
      state: rejectedState, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: false,
      notify: () => {}, composer: null,
    });
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, rejection!.ack)).toEqual({ status: 'accepted' });
    expect(ActionExecuteFailureSchema.parse(await notCurrent)).toMatchObject({
      ok: false, errorCode: 'current_session_presentation_not_current',
      details: {
        stage: 'client_acknowledgement', reason: 'client_not_current', hostNonce: bound.hostNonce,
        revision: rejectedState.revision, clientId: 'viewer-client', commandId: 'agent-no-longer-current',
      },
    });
    });
  });
});
