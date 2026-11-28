import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createDeferred } from '@/testkit/async/deferred';
import { runHostSessionRuntime, type HostSessionRuntimeConfig, type HostSessionRuntimeFactoryParams,
  type HostSessionRuntimeRunOptions } from './runHostSessionRuntime';
import type { RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createNativeAgentRuntimeSessionPlan } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { SessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { configuration } from '@/configuration';
import type { AgentRuntime, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.composed.testkit';

export const MCP_REQUESTER_SDK_FIXTURE_KEY = 'happier.test.mcp-requester-sdk';

/** Existing Session HTTP/bootstrap and vendor runtime are the only boundaries.
 * Keep the real parent alive while public child operations consume its controls. */
export async function startMcpRequesterParent(input: Readonly<{
  credentials: StoredCredentials;
  session: ApiSessionClient;
  sessionRow?: Parameters<ApiClient['sessionSyncClient']>[0];
  api: ApiClient;
  machineId: string;
  snapshot: ActiveAccountSettingsSnapshot;
  pluginRuntimeRegistryLease: HostSessionRuntimeConfig['pluginRuntimeRegistryLease'];
  backendTarget?: HostSessionRuntimeRunOptions['backendTarget'];
  nativeParentSelection?: boolean;
  foregroundRunnerBootstrap?: Readonly<{ agentId: string; bootstrapFilePath: string; authorityFilePath: string }>;

  agentConfig?: Pick<HostSessionRuntimeConfig, 'flavor' | 'policyAgentId' | 'backendDisplayName' | 'providerName'
    | 'uiLogPrefix' | 'waitingForCommandLabel' | 'agentMessageType'>;
}>) {
  const metadata = input.session.getMetadataSnapshot();
  if (!metadata) throw new Error('Missing parent Session metadata');
  const ready = createDeferred<void>();
  const finish = createDeferred<void>();
  const finished = new Error('Parent fixture ended after source observation');
  let parent: HostSessionRuntimeFactoryParams | undefined;
  let controls: SessionRuntimeControls | null = null;
  let requestRuntimeStop: (() => Promise<void>) | undefined;
  let startedRuntime: RuntimeTurnOperations | undefined;
  let liveSession = input.session;
  let originalControls = liveSession.setSessionRuntimeControls;
  const installControls: typeof originalControls = next => {
    controls = next;
    originalControls.call(liveSession, next);
  };
  if (!input.nativeParentSelection) liveSession.setSessionRuntimeControls = installControls;
  const vendorModel = { currentModelId: 'default', models: [{ id: 'default', name: 'Default' }] };
  let completeCurrentTurn: (() => void) | undefined;
  const providerInputs: Parameters<AgentSessionRuntime['send']>[0][] = [];
  const createSdkSession = (): AgentSessionRuntime => {
    const lifetime = new AbortController();
    let eventSequence = 0;
    let eventListener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let incarnationTurnId: string | null = null;
    const emit = (event: Record<string, unknown>) => eventListener?.(AgentSessionRuntimeEventV1Schema.parse({
      sequence: ++eventSequence, sessionId: liveSession.sessionId, emittedAtMs: Date.now(), ...event,
    }));
    completeCurrentTurn = () => {
      if (incarnationTurnId) emit({ kind: 'turn-complete', turnId: incarnationTurnId });
    };
    void finish.promise.then(() => { if (incarnationTurnId) emit({ kind: 'turn-complete', turnId: incarnationTurnId }); });
    return {
      async send(request) {
        providerInputs.push(request);
        incarnationTurnId = request.delivery.turnId;
        emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        emit({ kind: 'turn-start', turnId: incarnationTurnId, startedBy: 'host' });
        return { status: 'admitted' };
      },
      watch(listener) { eventListener = listener; return { dispose() { if (eventListener === listener) eventListener = undefined; } }; },
      async updateConfiguration(request) { return { status: 'applied', changed: [
        ...(request.workspaceWrites ? ['workspaceWrites' as const] : []),
        ...(request.permissionIntent ? ['permissionIntent' as const] : []),
      ] }; },
      dispose() { lifetime.abort(); },
    };
  };
  const openSdkSession: NonNullable<AgentRuntime['sessions']>['open'] = async (_request, context) => {
    context.session.services.models.bind({ read: () => vendorModel,
      subscribe(listener) { listener(vendorModel); return { dispose() {} }; } });
    return createSdkSession();
  };
  // Only the retained fixture Agent's external SDK open is replaced. Its
  // executable source, bootstrap, authority claim and input admission stay real.
  const sdkFixtureKey = Symbol.for(MCP_REQUESTER_SDK_FIXTURE_KEY);
  const previousSdkFixture = Reflect.get(globalThis, sdkFixtureKey);
  if (input.foregroundRunnerBootstrap) Reflect.set(globalThis, sdkFixtureKey, openSdkSession);
  const restoreSdkFixture = () => {
    if (Reflect.get(globalThis, sdkFixtureKey) !== openSdkSession) return;
    if (previousSdkFixture === undefined) Reflect.deleteProperty(globalThis, sdkFixtureKey);
    else Reflect.set(globalThis, sdkFixtureKey, previousSdkFixture);
  };
  const nativePlan = input.foregroundRunnerBootstrap
    ? await new SessionHostBridge().createSessionRuntime(input.foregroundRunnerBootstrap.agentId, {
      credentials: input.credentials, happyHomeDir: configuration.happyHomeDir,
      directory: metadata.path, startedBy: 'terminal',
    }, { pluginRuntimeRegistryLease: input.pluginRuntimeRegistryLease,
      agentRuntimeRunnerBootstrapFilePath: input.foregroundRunnerBootstrap.bootstrapFilePath,
      agentRuntimeDaemonServiceAuthorityFilePath: input.foregroundRunnerBootstrap.authorityFilePath })
    : input.nativeParentSelection ? await createNativeAgentRuntimeSessionPlan({
    ...createExternalContributionFixtures('codex'),
    policyAgentId: input.agentConfig?.policyAgentId ?? 'pi',
    sessionInput: buildPluginSessionBindingInput({ credentials: input.credentials, directory: metadata.path }),
    lease: createLease('codex'),
    sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false,
      configuration: true, workspaceWrites: 'deny' },
    createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
    // Only the external provider SDK is substituted. Production native admission,
    // publications, witness projection, and replacement remain on their owners.
    runtime: { sessions: { open: openSdkSession } },
  }) : null;
  const vendor: RuntimeTurnOperations & { setOnPromptDeliveryOutcome(): void;
    readAppliedTeamCredentialModel?: () => null;
    openedWithoutConnectedServices?: () => boolean;
    models?: { read: () => typeof vendorModel; subscribe: (listener: (snapshot: typeof vendorModel) => void) => { dispose: () => void } } } = {
    beginTurnLifecycle() {}, async sendTurnPrompt() {}, async steerInFlightTurn() {},
    async waitForTurnCompletion() {}, subscribeRuntimeEvents: () => () => undefined,
    async cancelTurn() {}, readSessionIdentity: () => ({ sessionId: null }),
    async updateSessionRuntimeConfig() {}, async resetOrDisposeRuntime() {},
    setOnPromptDeliveryOutcome() {},
    ...(input.nativeParentSelection ? {
      // The vendor SDK is the test boundary; the host's model-transition and
      // connected-service authorities still produce the applied selection.
      readAppliedTeamCredentialModel: () => null,
      openedWithoutConnectedServices: () => true,
      models: { read: () => vendorModel, subscribe: (listener: (snapshot: typeof vendorModel) => void) => {
        listener(vendorModel);
        return { dispose: () => undefined };
      } },
    } : {}),
  };
  const outcome = runHostSessionRuntime({ credentials: input.credentials, directory: metadata.path,
    startedBy: input.foregroundRunnerBootstrap ? 'terminal' : 'daemon', accountSettingsContext: { ...input.snapshot, whenRefreshed: null },
    ...(input.backendTarget ? { backendTarget: input.backendTarget } : {}) }, {
    ...(input.foregroundRunnerBootstrap ? nativePlan?.config : {}),
    flavor: 'pi', policyAgentId: 'pi', backendDisplayName: 'Pi', providerName: 'Pi',
    uiLogPrefix: '[MCP parent fixture]', waitingForCommandLabel: 'Pi', agentMessageType: 'pi',
    ...input.agentConfig,
    runtimeActivityApplicability: 'not_applicable', pluginRuntimeRegistryLease: input.pluginRuntimeRegistryLease,
    machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test',
      homeDir: metadata.path, happyHomeDir: metadata.path, happyLibDir: metadata.path },
    loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
    formatPromptErrorMessage: String, startRuntimeBeforeFirstPrompt: true,
    ...(input.nativeParentSelection ? { processLifecycleOwnership: 'caller' as const,
      onRuntimeStopReady: (stop: () => Promise<void>) => { requestRuntimeStop = stop; } } : {}),
    onAfterStart: async ({ runtime }) => {
      startedRuntime = runtime;
      ready.resolve();
      if (!input.nativeParentSelection) { await finish.promise; throw finished; }
    },
    createSessionRuntime: async params => {
      parent = params;
      if (nativePlan?.config.createSessionRuntime) {
        return nativePlan.config.createSessionRuntime(params);
      }
      return { operations: vendor, nativeRuntime: vendor };
    },
  }, {
    initializeBackendApiContextFn: async () => ({ api: input.api, machineId: input.machineId }),
    initializeBackendRunSessionFn: async params => {
      if (input.nativeParentSelection) {
        if (!input.sessionRow) throw new Error('Native parent requires its original Session row');
        liveSession = await params.api.sessionSyncClient(input.sessionRow);
        originalControls = liveSession.setSessionRuntimeControls;
        liveSession.setSessionRuntimeControls = installControls;
      }
      return { session: liveSession, reconnectionHandle: null,
        reportedSessionId: liveSession.sessionId, attachedToExistingSession: false };
    },
  });
  // The race below observes failures; attach immediately while startup is pending.
  void outcome.catch(() => undefined);
  try {
    await Promise.race([ready.promise, outcome.then(() => { throw new Error('Parent ended before ready'); })]);
    if (!parent || !controls) throw new Error('Missing opened parent controls');
    const mcpSession = liveSession as RunnerMcpSessionWithContext<ApiSessionClient>;
    if (input.nativeParentSelection && (!mcpSession.getBackendTarget || !mcpSession.getSessionRoleContext)) {
      throw new Error('Live parent did not install its MCP Session context');
    }
    return { parent, mcpSession, readControls: () => controls,
      readProviderInputs: () => [...providerInputs],
      completeCurrentTurn() {
        if (!completeCurrentTurn) throw new Error('Native provider turn is unavailable');
        completeCurrentTurn();
      },
      submitUserPrompt(text: string, permissionMode: 'default' | 'yolo' = 'default') {
        if (!parent?.messageQueue) throw new Error('Host prompt queue is unavailable');
        parent.messageQueue.push({ text, localId: crypto.randomUUID(), userMessageSeq: 1 }, { permissionMode });
      },
      async submitNativePrompt(text: string) {
        if (!startedRuntime) throw new Error('Native Session runtime is unavailable');
        await startedRuntime.sendTurnPrompt(text, { localId: crypto.randomUUID(),
          turnId: crypto.randomUUID(), userMessageSeq: 1 });
      },
      async stop() {
      try {
        finish.resolve();
        if (input.nativeParentSelection && requestRuntimeStop) await requestRuntimeStop();
        await outcome.catch(error => { if (error !== finished) throw error; });
      }
      finally {
        restoreSdkFixture();
        if (liveSession.setSessionRuntimeControls === installControls) liveSession.setSessionRuntimeControls = originalControls;
      }
    } };
  } catch (error) {
    restoreSdkFixture();
    if (liveSession.setSessionRuntimeControls === installControls) liveSession.setSessionRuntimeControls = originalControls;
    throw error;
  }
}
