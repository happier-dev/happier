import { once } from 'node:events';
import { Agent, createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { expect, vi } from 'vitest';
import { ProviderConnectionIdSchema, type AgentSessionRuntimeEventV1 } from '@happier-dev/protocol';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { createProviderBrokerRouteGrantSigningInputV2, type SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { IROH_MACHINE_ADMISSION_PATH, IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER, IROH_MACHINE_REMOTE_ENDPOINT_HEADER } from '@happier-dev/iroh-native/node';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createPeerMediationLoopbackApp } from '@/daemon/peer/mediation/loopback/server';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createAccountConnectionBrokerSourceOpen, createAccountConnectionManagedConsumerSourceOpen,
  retireAccountConnectionBrokerSource } from '@/providers/broker/accountConnectionSource';
import { startDaemonProviderBrokerRuntime } from '@/providers/broker/daemonProviderBrokerRuntime';
import { createTeamCredentialBrokerSourceOwner } from '@/providers/broker/teamCredentialBrokerSourceOwner';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createAccountConnectionModelProjectionRequest } from '@/providers/broker/applicationProjection';
import type { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import type { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { createRuntimeTranscriptProjector, type RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createCodexAppServerRuntime, waitForCodexAppServerRuntimeTurnCompletion } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import type { DisposableCodexAppServerClient } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';

type Fixture = Awaited<ReturnType<typeof createManagedRunLaunchFixture>>;
type Body = Parameters<NonNullable<RuntimeTranscriptProjectionSession['enqueueAgentMessageCommitted']>>[1];

/** Controlled upstream, behind the existing installed OS gateway fixture.
 * HTTP and durable credential materialization are system boundaries. Purpose
 * leases, subject authentication and request-auth lookup all run for real. */
export async function startGatewayJourneyUpstream() {
  let fixture: Fixture | undefined;
  const effects: string[] = [];
  const held = new Map<string, ServerResponse>();
  let beforeLookup: () => Promise<void> = async () => {};
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected auth recovery'); };
  const auth = createConnectedAccountRequestAuthService({
    // Explicit budget of this controlled request (matching the Go lookup
    // conformance vector); the valid 35-second phase must fit inside it.
    operationDeadlineMs: 60_000,
    resolveCurrentBinding: async input => {
      await beforeLookup();
      if (!input.subject.bindingAuthority) throw new Error('Missing real purpose lease');
      return input.subject.bindingAuthority.resolveCurrentBinding(input);
    },
    materializeHeaders: input => {
      if (!input.subject.bindingAuthority) throw new Error('Missing real purpose lease');
      return input.subject.bindingAuthority.materializeHeaders(input);
    }, refreshAfterAuthFailure: unexpected, reportQuotaFailure: unexpected,
  });
  const emit = (response: ServerResponse, event: Record<string, unknown>) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const complete = (response: ServerResponse, text: string) => {
    emit(response, { type: 'response.output_text.delta', delta: text });
    emit(response, { type: 'response.completed', response: { status: 'completed' } });
    response.end();
  };
  const server = createServer(async (request, response) => {
    const signal = new AbortController();
    response.once('close', () => signal.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || !('input' in body) || typeof body.input !== 'string') throw new Error('Invalid fixture input');
      const text = body.input;
      const gateway = fixture?.gateway;
      const subject = gateway?.requestAuthRegistry.authenticate(request.headers['x-fixture-capability']);
      if (!gateway || !subject) { response.writeHead(403).end(); return; }
      await auth.lookupRequestAuth({ subject, purpose: gateway.purposeBindings.bindings[0]!.purpose, signal: signal.signal });
      effects.push(text);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      emit(response, { type: 'response.created', response: { id: `response-${effects.length}`, status: 'in_progress' } });
      if (text.startsWith('hold:')) {
        emit(response, { type: 'response.output_text.delta', delta: 'unfinished prefix' });
        held.set(text, response);
        response.once('close', () => held.delete(text));
        return;
      }
      if (text.startsWith('tool:')) {
        emit(response, { type: 'response.output_item.done', item: {
          type: 'function_call', call_id: `call-${effects.length}`, name: 'exec_command', arguments: '{"cmd":"pwd"}',
        } });
      }
      complete(response, `SENTINEL:${text}`);
    } catch {
      if (!response.headersSent) response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'request_auth_unavailable' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing controlled upstream');
  return { url: `http://127.0.0.1:${address.port}/responses`, effects, held,
    bind(value: Fixture) { fixture = value; },
    beforeLookup(callback: () => Promise<void>) { beforeLookup = callback; },
    finish(text: string) { const response = held.get(text); if (!response) throw new Error('Missing held stream'); complete(response, `SENTINEL:${text}`); },
    async close() { for (const response of held.values()) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Substitute only the external Codex JSON-RPC process. Its Responses HTTP
 * requests traverse the real consumer/broker; the native and host projectors
 * consume the same notifications as the established Codex transcript fixture. */
function createJourneyCodex(sessionId: string, endpoint: Readonly<{ endpointUrl: string; renderedCredential: string }>) {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const stored = new Map<string, Body>();
  const events: AgentSessionRuntimeEventV1[] = [];
  const sends: string[] = [];
  const interrupts: unknown[] = [];
  const failures: string[] = [];
  const jobs: Promise<void>[] = [];
  const requests = new Map<string, AbortController>();
  const session = { sessionId, enqueueAgentMessageCommitted: async (_provider: string, body: Body, options: { localId: string }) => {
    stored.set(options.localId, body); return { persisted: true, delivered: false };
  } };
  const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });
  const project = createRuntimeTranscriptProjector();
  let projection = Promise.resolve();
  let nextTurn = 0;
  const nativeObservers = new Set<Parameters<DisposableCodexAppServerClient['onNativeEvent']>[0]>();
  const notify = async (method: string, params: Record<string, unknown>) => {
    for (const observer of nativeObservers) observer(method, params, Date.now());
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Missing native notification ${method}`);
    await handler(params);
  };
  const client: DisposableCodexAppServerClient = {
    launchFeatures: { realtimeConversationAdvertised: false },
    request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: sessionId } };
      if (method === 'account/read') return { account: null };
      if (method === 'account/rateLimits/read') return { rateLimits: null };
      if (method === 'turn/interrupt') {
        interrupts.push(params);
        if (!params || typeof params !== 'object' || !('threadId' in params)
          || params.threadId !== sessionId || !('turnId' in params) || typeof params.turnId !== 'string') {
          throw new Error('Interrupt must identify the exact native thread and turn');
        }
        const controller = requests.get(params.turnId);
        if (!controller) throw new Error('Interrupt targeted an inactive native turn');
        controller.abort();
        return {};
      }
      if (method !== 'turn/start') throw new Error(`Unexpected native request ${method}`);
      const input = params && typeof params === 'object' && 'input' in params ? params.input : null;
      const text = Array.isArray(input) ? input.flatMap(value => value?.type === 'text' ? [String(value.text)] : []).join('\n') : '';
      sends.push(text);
      const turnId = `native-${++nextTurn}`;
      const scope = { threadId: sessionId, turnId };
      const controller = new AbortController();
      requests.set(turnId, controller);
      // Native admission returns before notifications, as in the real process.
      jobs.push(new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        let message = '';
        try {
          const response = await fetch(`${endpoint.endpointUrl}/responses`, { method: 'POST',
            headers: { authorization: endpoint.renderedCredential, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gateway-model', input: text, stream: true }), signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Native HTTP ${response.status}: ${await response.text()}`);
          let buffered = '';
          for await (const chunk of response.body) {
            buffered += new TextDecoder().decode(chunk);
            let end: number;
            while ((end = buffered.indexOf('\n\n')) !== -1) {
              const line = buffered.slice(0, end); buffered = buffered.slice(end + 2);
              if (!line.startsWith('data: ')) continue;
              const event = JSON.parse(line.slice(6));
              if (event.type === 'response.output_text.delta') {
                message += event.delta;
                await notify('item/agentMessage/delta', { ...scope, itemId: turnId, delta: event.delta });
              }
              if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
                const item = { type: 'commandExecution', id: event.item.call_id, command: 'pwd' };
                await notify('item/started', { ...scope, item });
                await notify('item/completed', { ...scope, item: { ...item, status: 'completed', aggregatedOutput: '/fixture\n', exitCode: 0 } });
              }
            }
          }
          await notify('item/completed', { ...scope, item: { type: 'agentMessage', id: turnId, text: message } });
          await notify('turn/completed', { ...scope, turn: { id: turnId, status: 'completed' } });
        } catch (error) {
          if (!controller.signal.aborted) failures.push(error instanceof Error ? error.message : 'Native boundary failed');
          if (controller.signal.aborted) {
            await notify('turn/completed', { ...scope, turn: { id: turnId, status: 'interrupted' } });
          } else if (text === 'hold:outage') {
            // c42's native willRetry evidence supersedes the interrupted item.
            // There is deliberately no second native send or upstream replay.
            await notify('error', { ...scope, willRetry: true, error: { message: 'stream failed' } });
            await notify('item/agentMessage/delta', { ...scope, itemId: `${turnId}-settled`, delta: 'Interrupted answer settled' });
            await notify('item/completed', { ...scope, item: { type: 'agentMessage', id: `${turnId}-settled`, text: 'Interrupted answer settled' } });
            await notify('turn/completed', { ...scope, turn: { id: turnId, status: 'completed' } });
          } else {
            await notify('error', { ...scope, willRetry: false, error: { message: 'Controlled native request failed' } });
            await notify('turn/completed', { ...scope, turn: { id: turnId, status: 'failed', error: { message: 'Controlled native request failed' } } });
          }
        } finally { requests.delete(turnId); }
      }));
      return { turnId };
    },
    notify: async () => {}, registerRequestHandler: () => () => {},
    registerNotificationHandler: (method, handler) => { handlers.set(method, handler); return () => handlers.delete(method); },
    onNativeEvent: observer => { nativeObservers.add(observer); return () => { nativeObservers.delete(observer); }; },
    onExit: () => () => {}, dispose: async () => {},
  };
  const runtime = createCodexAppServerRuntime({ happierSessionId: sessionId, directory: '/fixture',
    host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient: async () => client } });
  const native = createCodexNativeAppServerSessionRuntime(runtime, sessionId);
  native.watch(event => { events.push(event); projection = projection.then(async () => {
    await project({ session, provider: 'codex', runtimeMessageDeltaBridge: bridge, event });
  }); });
  return { native, events, stored, sends, interrupts, failures,
    async stopThroughHost(text: string, waitForStream: () => Promise<void>, assertStreamClosed: () => Promise<void>) {
      const base = createLifecycleParams();
      Object.assign(base.session, { sessionId });
      const permission = new ProviderEnforcedPermissionHandler(base.session, { logPrefix: '[Gateway Stop]' });
      let releaseWrite!: () => void;
      const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
      let holdWrites = false;
      const committed: Body[] = [];
      const transcriptWriter = vi.spyOn(base.session, 'enqueueAgentMessageCommitted').mockImplementation(async (_provider, body) => {
        // Hold the real transcript transport boundary after native settlement.
        // Cancellation publication must not wait for the partial answer's ACK.
        if (body.type === 'message') await writeReleased;
        committed.push(body);
        return { persisted: true, delivered: true, committedSequence: body.type === 'message' ? 42 : 43 };
      });
      Object.assign(base.session, {
        getLastObservedMessageSeq: () => 43,
        getCommittedUserMessageSeq: () => 40,
      });
      const updateAgentState = base.session.updateAgentState.bind(base.session);
      // Replace only Home persistence. Real permission withdrawal, host turn
      // ownership, Codex adapter and streamed Gateway transport remain composed.
      const writer = vi.spyOn(base.session, 'updateAgentState').mockImplementation(async updater => {
        if (holdWrites) await writeReleased;
        await updateAgentState(updater);
      });
      const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
      if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Codex declaration');
      const lifetime = new AbortController();
      const services = createUnavailablePluginServices();
      const context = createAcpSessionRuntimeContextFixture({
        agent: declaration.richDefinition.definition, pluginId: declaration.pluginId,
        sessionId, directory: '/fixture', signal: lifetime.signal,
        session: base.session, permissionHandler: permission, services,
        protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: declaration.id,
          signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, services }),
      });
      const operations = createNativeAgentSessionInteractionOperations({ session: native, sessionId,
        cwd: '/fixture', context: context.context, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true } });
      let abort: (() => void | Promise<void>) | null = null;
      try {
        await runSessionLoopLifecycle({ ...base, runtime: operations, hookRuntime: operations,
          permissionHandler: permission,
          setAbortRequestedCallback: callback => { abort = callback; },
          deps: { ...base.deps, runPermissionModePromptLoopFn: async () => {
            await operations.sendTurnPrompt(text, { localId: `${sessionId}-${sends.length}`, turnId: `host-${sends.length}` });
            await waitForStream();
            holdWrites = true;
            const stopping = abort?.();
            void Promise.resolve(stopping).catch(() => undefined);
            try {
              await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-cancelled')).toBe(true));
              await assertStreamClosed();
              await vi.waitFor(() => expect(committed.filter(body => body.type === 'turn_cancelled')).toHaveLength(1));
              await vi.waitFor(() => expect(base.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'cancel' }),
              ));
              expect(committed.some(body => body.type === 'message')).toBe(false);
            } finally {
              holdWrites = false;
              releaseWrite();
              await stopping;
            }
          } },
        });
      } finally {
        holdWrites = false;
        releaseWrite();
        writer.mockRestore();
        transcriptWriter.mockRestore();
        lifetime.abort();
        await context.dispose();
      }
      expect(committed.filter(body => body.type === 'turn_cancelled')).toHaveLength(1);
      expect(committed).toContainEqual(expect.objectContaining({ type: 'message', message: 'unfinished prefix' }));
      expect(base.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
        action: 'append_transcript_anchors', transcriptAnchors: expect.objectContaining({ finalAssistantMessageSeq: 42 }),
      }));
      await projection;
    },
    async send(text: string) {
      const terminals = events.filter(event => ['turn-complete', 'turn-cancelled', 'turn-failed'].includes(event.kind)).length;
      const admitted = await native.send({ inputIds: [`${sessionId}-${sends.length}`], input: { text }, delivery: { kind: 'newTurn', turnId: `host-${sends.length}` } });
      expect(admitted, `${sessionId}: ${text}: ${JSON.stringify(admitted)}`).toMatchObject({ status: 'admitted' });
      const completion = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      return async () => {
        await completion;
        expect(events.filter(event => ['turn-complete', 'turn-cancelled', 'turn-failed'].includes(event.kind)), `${sessionId}: ${text}`).toHaveLength(terminals + 1);
        await projection;
      };
    },
    async close() { for (const controller of requests.values()) controller.abort(); await Promise.all(jobs); await projection; await native.dispose(); bridge.clear(); },
  };
}

export async function exerciseGatewayStreamJourney(input: Readonly<{
  fixture: Fixture;
  upstream: Awaited<ReturnType<typeof startGatewayJourneyUpstream>>;
  snapshot(): ActiveAccountSettingsSnapshot;
  hubModels: ReturnType<typeof createRuntimeProviderModelManagementServices>;
  peerId: string;
  setEnabled(enabled: boolean): Promise<unknown>;
  deliverPending(send: (text: string) => Promise<void>): Promise<void>;
}>) {
  const { fixture, upstream, peerId } = input;
  const gateway = fixture.gateway!;
  const signal = new AbortController().signal;
  const declaration = fixture.contributes.providersByContributionKey.get(`${gateway.identity.pluginId}/${gateway.identity.localId}`)!.definition;
  const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir, controller: gateway.controller });
  const application = { agentTargetKey: fixture.agentTargetKey, implementationIdentity: gateway.identity, endpointTemplateId: 'api', protocol: 'openai-responses' as const };
  const resolved = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
    providerSettings: readProviderSettingsForCli(input.snapshot()).settings, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
  if (resolved.status !== 'resolved' || resolved.record.deployment.kind !== 'managedLocal') throw new Error('Expected exact managed hub');
  const source = { kind: 'account_connection' as const, connectionId: ProviderConnectionIdSchema.parse('run-gateway'),
    expectedConnectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
    expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({ implementationIdentity: gateway.identity,
      managedRuntime: declaration.managedRuntime!, purposeBindings: resolved.record.deployment.purposeBindingIntents }) };
  const current = (machineId: string) => {
    const value = resolveProviderConnectionForMachine({ connectionId: source.connectionId, machineId,
      providerSettings: readProviderSettingsForCli(input.snapshot()).settings, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
    return value.status === 'resolved' && value.record.authorization.authorized;
  };
  const common = { homeId: 'home', accountId: 'account', machineId: fixture.machineId, custody,
    expectedAccountSettingsScopeKey: input.snapshot().scopeKey!, getAccountSettingsSnapshot: input.snapshot,
    withRegistry: async <T>(read: (registry: typeof fixture.contributes) => T | Promise<T>) => await read(fixture.contributes),
    resolveBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
    projectModels: (request: Parameters<typeof input.hubModels.projectModels>[0]) => input.hubModels.projectModelsForAccount(request, {
      getAccountSettingsSnapshot: input.snapshot, resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent, signal, isCurrent: () => true }),
  };
  const open = createAccountConnectionManagedConsumerSourceOpen({ ...common, admitConsumer: async request => current(request.consumerMachineId) });
  const consumers: { cleanup(): Promise<void> }[] = [];
  const natives: ReturnType<typeof createJourneyCodex>[] = [];
  const sources: NonNullable<Awaited<ReturnType<typeof open>>>[] = [];
  const attach = async (sessionId: string) => {
    const access = await open({ source, application, consumer: { kind: 'session', sessionId }, consumerMachineId: fixture.machineId, signal });
    if (!access) {
      const projection = await common.projectModels(createAccountConnectionModelProjectionRequest({ machineId: fixture.machineId,
        connectionId: source.connectionId, expectedConnectionSecurityFingerprint: source.expectedConnectionSecurityFingerprint,
        agentTargetKey: fixture.agentTargetKey, application, refreshPolicy: 'current_only' }));
      throw new Error(`Local source refused: ${JSON.stringify({ current: current(fixture.machineId), source, projection })}`);
    }
    sources.push(access);
    const endpoint = await startManagedProviderConsumerApplication({ signal, endpointUrl: access.access.endpointUrl('api')!,
      credentialTransport: declaration.credential!.transports[0]!, request: async request => await access.revalidate(request.signal)
        ? { ok: true, response: await access.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
    consumers.push(endpoint);
    const native = createJourneyCodex(sessionId, endpoint); natives.push(native);
    return { access, endpoint, native };
  };
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
  const roots = [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }];
  const payload: SignedProviderBrokerRouteGrantV2['payload'] = { v: 2, grantId: 'journey-peer', aud: 'happier-provider-broker-route-v2',
    issuedAt: 100, expiresAt: 200, homeId: 'home', accountId: 'account', initiatorTokenEpoch: 0,
    source, application, consumer: { kind: 'session', sessionId: 'peer-session' },
    initiator: { accountId: 'account', machineId: peerId, endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'account', machineId: fixture.machineId, endpointId: 'b'.repeat(64) } };
  const authority: SignedProviderBrokerRouteGrantV2 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
    valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } };
  const broker = await startDaemonProviderBrokerRuntime({ machineId: fixture.machineId, resolveTrustRoots: () => roots, nowMs: () => 150,
    createRequestId: () => 'journey-request', resolveRequestPolicy: async () => null,
    admitRequest: async () => ({ ok: false, reasonCode: 'resource_forbidden' }), authorizeModelCatalog: async () => ({ ok: false, reasonCode: 'resource_forbidden' }),
    sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: fixture.machineId, custody,
      selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null, openProviderConnectionSource: async () => null }),
    accountConnection: { homeId: 'home', accountId: 'account',
      open: createAccountConnectionBrokerSourceOpen({ ...common, admitConsumer: async value => current(value.payload.initiator.machineId) }),
      retire: request => retireAccountConnectionBrokerSource({ ...common, authority: request.authority }) },
  });
  const admission = createPeerMediationLoopbackApp({ nowMs: () => 150, trustRoots: roots,
    expected: { accountId: 'account', machineId: fixture.machineId, flowKind: 'bounded_transfer', routeKind: 'loopback_direct', endpointFingerprint: 'unused' },
    irohMachineAdmission: { localEndpointId: payload.target.endpointId, role: 'acceptor', allowedFlows: [], resolveApplicationTarget: () => null,
      resolveProviderBrokerApplicationTarget: broker.resolveProviderBrokerApplicationTarget } });
  try {
    const [first, survivor] = await Promise.all([attach('main-one'), attach('main-two')]);
    expect(first.endpoint.renderedCredential).not.toBe(survivor.endpoint.renderedCredential);
    expect(first.access.access.endpointUrl('api')).toBe(survivor.access.access.endpointUrl('api'));
    const processFile = join(gateway.directory, 'gateway-started');
    const originalPid = Number(await readFile(processFile, 'utf8'));
    const baselineStarts = (await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n');
    await (await first.native.send('tool:main'))();
    expect(first.native.events.filter(event => event.kind === 'tool-call')).toHaveLength(1);
    expect(first.native.events.filter(event => event.kind === 'tool-result')).toHaveLength(1);
    expect([...first.native.stored.values()].filter(body => body.type === 'tool-call')).toHaveLength(1);
    expect([...first.native.stored.values()].filter(body => body.type === 'tool-result')).toHaveLength(1);
    expect([...first.native.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:tool:main' });

    // Native machine/1 transport is the only replacement: the real admission
    // handler verifies Home signature and exact peer identity before producing
    // its private first-bytes application stream.
    let beforeBrokerAdmission: () => Promise<void> = async () => {};
    const peerEndpoint = await startManagedProviderConsumerApplication({ signal, endpointUrl: first.endpoint.endpointUrl,
      credentialTransport: declaration.credential!.transports[0]!, request: async request => {
        await beforeBrokerAdmission();
        const admitted = await admission.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
          headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: payload.initiator.endpointId },
          payload: { v: 2, kind: 'provider_broker', authority } });
        if (admitted.statusCode !== 204) return { ok: false, reasonCode: 'resource_forbidden' };
        const port = Number(admitted.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]);
        const capability = String(admitted.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]);
        const socket = connect({ host: '127.0.0.1', port });
        await once(socket, 'connect');
        socket.write(capability, 'ascii');
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => socket;
        const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          const forwarded = httpRequest({ host: '127.0.0.1', port, path: request.pathAndQuery, method: request.method,
            headers: { ...request.headers, connection: 'close' }, signal: request.signal, agent,
          }, resolve);
          forwarded.once('error', error => { agent.destroy(); reject(error); }); forwarded.end(request.body);
        });
        response.once('close', () => agent.destroy());
        return { ok: true, response: { ok: response.statusCode! < 400, status: response.statusCode!, statusText: response.statusMessage ?? '', headers: Object.fromEntries(Object.entries(response.headers)
          .flatMap(([name, value]) => value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]])),
          body: Readable.toWeb(response) as ReadableStream<Uint8Array> } };
      } });
    consumers.push(peerEndpoint);
    const peer = createJourneyCodex('peer-session', peerEndpoint); natives.push(peer);
    await (await peer.send('tool:peer'))();
    expect(peer.failures).toEqual([]);
    expect(peer.events.filter(event => event.kind === 'tool-call')).toHaveLength(1);
    expect(peer.events.filter(event => event.kind === 'tool-result')).toHaveLength(1);
    expect([...peer.stored.values()].filter(body => body.type === 'tool-call')).toHaveLength(1);
    expect([...peer.stored.values()].filter(body => body.type === 'tool-result')).toHaveLength(1);
    expect([...peer.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:tool:peer' });
    expect((await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n')).toEqual(baselineStarts);

    await first.native.stopThroughHost('hold:cancel',
      async () => { await vi.waitFor(() => expect(upstream.held.has('hold:cancel')).toBe(true)); },
      async () => { await vi.waitFor(() => expect(upstream.held.has('hold:cancel')).toBe(false)); });
    expect(first.native.interrupts).toEqual([{ threadId: 'main-one', turnId: 'native-2' }]);
    // The upstream never finishes this response: only native cancellation can
    // close it through the consumer, broker and shared Gateway stream owners.
    await vi.waitFor(() => expect(upstream.held.has('hold:cancel')).toBe(false));
    expect(first.native.events.filter(event => event.kind === 'turn-cancelled')).toHaveLength(1);
    await (await survivor.native.send('after-cancel'))();
    expect([...survivor.native.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:after-cancel' });
    await first.native.close(); await first.endpoint.cleanup(); await first.access.retire();
    expect(process.kill(originalPid, 0)).toBe(true);
    await (await survivor.native.send('after-close'))();
    expect([...survivor.native.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:after-close' });

    const interrupted = await survivor.native.send('hold:outage');
    await vi.waitFor(() => expect(upstream.held.has('hold:outage')).toBe(true));
    await vi.waitFor(() => expect([...survivor.native.stored.values()])
      .toContainEqual({ type: 'message', message: 'unfinished prefix' }));
    process.kill(originalPid, 'SIGTERM');
    expect(await waitForProcessExit(originalPid)).toBe(true);
    await interrupted();
    expect([...survivor.native.stored.values()].filter(body => body.type === 'message' && body.message === 'unfinished prefix')).toEqual([]);
    expect([...survivor.native.stored.values()].filter(body => body.type === 'message' && body.message === 'Interrupted answer settled')).toHaveLength(1);
    await input.deliverPending(async text => { await (await survivor.native.send(text))(); });
    const replacementPid = Number(await readFile(processFile, 'utf8'));
    expect(replacementPid).not.toBe(originalPid);
    expect((await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n')).toEqual([...baselineStarts, String(replacementPid)]);
    expect(upstream.effects.filter(text => text === 'hold:outage')).toHaveLength(1);
    expect(upstream.effects.filter(text => text === 'pending-fresh')).toHaveLength(1);
    expect(survivor.native.sends.filter(text => text === 'pending-fresh')).toHaveLength(1);
    expect([...survivor.native.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:pending-fresh' });

    // Delay the actual request-auth boundary beyond the former local cutoff.
    let entered!: () => void; let release!: () => void;
    const lookupEntered = new Promise<void>(resolve => { entered = resolve; });
    const lookupReleased = new Promise<void>(resolve => { release = resolve; });
    upstream.beforeLookup(async () => { entered(); await lookupReleased; });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const slow = await survivor.native.send('slow-valid');
    try { await lookupEntered; await vi.advanceTimersByTimeAsync(35_000); release(); }
    finally { release(); vi.useRealTimers(); }
    await slow();
    expect(upstream.effects.filter(text => text === 'slow-valid')).toHaveLength(1);
    expect([...survivor.native.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:slow-valid' });
    upstream.beforeLookup(async () => {});

    // Revoke after native admission, before the broker can publish an upstream
    // effect. Re-enable and retry once through the same live instances.
    let brokerEntered!: () => void; let brokerRelease!: () => void;
    const brokerWaiting = new Promise<void>(resolve => { brokerEntered = resolve; });
    const brokerReleased = new Promise<void>(resolve => { brokerRelease = resolve; });
    beforeBrokerAdmission = async () => { brokerEntered(); await brokerReleased; };
    const before = upstream.effects.length;
    const pendingRefusal = fetch(`${peerEndpoint.endpointUrl}/responses`, { method: 'POST',
      headers: { authorization: peerEndpoint.renderedCredential, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'revoked-peer', model: 'gateway-model', stream: true }) });
    try { await brokerWaiting; await input.setEnabled(false); }
    finally { brokerRelease(); }
    const refused = await pendingRefusal;
    expect(refused.status).toBe(403);
    // Revocation now refuses the application request's initial source opening,
    // before it has a retained projection to forward through.
    expect(await refused.json()).toMatchObject({ error: { code: 'resource_unavailable' } });
    expect(upstream.effects).toHaveLength(before);
    beforeBrokerAdmission = async () => {};
    await input.setEnabled(true);
    await (await peer.send('peer-person-retry'))();
    expect(upstream.effects.filter(text => text === 'peer-person-retry')).toHaveLength(1);
    expect([...peer.stored.values()]).toContainEqual({ type: 'message', message: 'SENTINEL:peer-person-retry' });
    expect(upstream.effects).toEqual(['tool:main', 'tool:peer', 'hold:cancel', 'after-cancel', 'after-close',
      'hold:outage', 'pending-fresh', 'slow-valid', 'peer-person-retry']);
  } finally {
    upstream.beforeLookup(async () => {});
    await Promise.all(natives.map(native => native.close()));
    await Promise.all(consumers.map(consumer => consumer.cleanup()));
    await Promise.all(sources.map(source => source.retire()));
    await retireAccountConnectionBrokerSource({ ...common, authority });
    await admission.close(); await broker.close();
  }
}
