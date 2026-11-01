import { expect, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import type { DaemonVoiceClientAccountOperationRequestV1 } from '@happier-dev/protocol/daemon/voiceCredentials';
import type { installVoiceWebRtcBrowserBoundary } from './voiceWebRtcHarness';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { Settings } from '@/sync/domains/settings/settings';
import type { BundledConversationRuntimeEntry } from '@/voice/registry/bundledConversationRuntimeEntries';
import type { VoiceAdapterController } from '@/voice/session/types';
import type { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import type { restoreServerAccountForTest } from './serverAccountConnectionHarness';
import type { createSessionMetadataHttpBoundary } from './sessionMetadataHttpBoundary';
import type { createConnectedPurposeCatalogHttpBoundary } from './connectedAccountCatalogBoundary';

type OpenAiRuntimeOptions = Readonly<{
  respondToDaemonAccountOperation?: OpenAiMintTransport;
  readPlaybackCursorMs?(): number | null;
  initialConversationSessionId?: string;
  currentUiContext?: VoiceCurrentUiToolPort;
}>;

type OpenAiVoiceRuntime = Readonly<{
  controlSessionId: string;
  historySessionId: string;
  adapter: VoiceAdapterController;
  controller: ReturnType<ReturnType<typeof createBundledConversationRuntimeHostLease>['host']['createConversationController']> | null;
  hostLease: ReturnType<typeof createBundledConversationRuntimeHostLease>;
  requestAccountOperation: ReturnType<typeof vi.fn>;
  requestReconnect(): Promise<boolean>;
  runtime: Readonly<{ adapter: VoiceAdapterController; dispose(): Promise<void> }>;
}>;

export type OpenAiVoiceRuntimeEnvironment = {
  subscribeNetwork(notify: () => void): () => void;
  entry: BundledConversationRuntimeEntry;
  historySessionId: string;
  credentialMachineId: string;
  providerFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  transcriptMessageUrl(sessionId: string): string;
  createClientAuthProviderResponse(value: string, expiresAt: number): Readonly<{
    value: string;
    expires_at: number;
    session: Readonly<{ type: string; object: string; id: string; model: string }>;
  }>;
  accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
  sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;
  purposes: ReturnType<typeof createConnectedPurposeCatalogHttpBoundary>;
  transcriptRequest: ReturnType<typeof vi.fn>;
  homeRequest(input: URL | RequestInfo, init?: RequestInit): Promise<Response | null>;
  allowedTranscriptMessageUrls: Set<string>;
  accountProfile: AccountProfile;
  mintTransport: OpenAiMintTransport;
  persistedAccountSettings: Settings;
  historySessionPost(init: RequestInit): Promise<Response>;
  publishAccountSettings(settings: Settings): Promise<void>;
  configureVoice(input: unknown): Promise<void>;
  selectConnectedAccount(accountId: string | null): Promise<void>;
  installSavedSecretSettings(): Promise<ConnectedPurposeCatalogV1>;
  installConnectedAccountSettings(): Promise<void>;
  createRuntime(browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>, options?: OpenAiRuntimeOptions): Promise<OpenAiVoiceRuntime>;
  dispose(): Promise<void>;
};

export type OpenAiMintTransport = (request: DaemonVoiceClientAccountOperationRequestV1) => Promise<Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>>;

/** The existing source-composed OpenAI recipe, loaded after file-level SDK boundaries. */
export async function createOpenAiVoiceRuntimeEnvironment(options: Readonly<{
  credentialSource?: 'savedSecret' | 'connectedAccount';
  voice?: unknown;
}> = {}): Promise<OpenAiVoiceRuntimeEnvironment> {
  const networkEvents = new EventTarget();
  const notifyNetwork = () => networkEvents.dispatchEvent(new Event('network'));
  await import('@/sync/syncEngine');
  const { createRecipientContractDigestV1, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } = await import('@happier-dev/protocol');
  const { DaemonVoiceClientAccountOperationRequestV1Schema, DaemonVoiceClientAccountOperationResponseV1Schema } = await import('@happier-dev/protocol/daemon/voiceCredentials');
  const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
  const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
  const { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema, V2SessionByIdResponseSchema } = await import('@happier-dev/protocol/sessions/control/contract');
  const { PLUGIN_MANIFEST: authoredOpenAiManifest } = await import('../../../../../../packages/plugins/openai/src/manifest');
  const OPENAI_SOURCE_MANIFEST = PluginManifestV2Schema.parse(authoredOpenAiManifest);
  const { activate: activateOpenAiVoice } = await import('../../../../../../packages/plugins/openai/src/ui/voice/runtime');
  const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
  const { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
  const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
  const { answerVoiceRealtimePreparationHttpRequest } = await import('@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary');
  const { createConnectedPurposeCatalogHttpBoundary } = await import('@/dev/testkit/harness/connectedAccountCatalogBoundary');
  const { resetConnectedAccountCatalogEngineForTests } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
  const { resetConnectedAccountCatalogSnapshotsForTests } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
  const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
  const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
  const { getActiveServerSnapshot, upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
  const { settingsDefaults, settingsParse, applySettings } = await import('@/sync/domains/settings/settings');
  const { storage } = await import('@/sync/domains/state/storage');
  const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
  const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
  const { normalizeVoiceSettingsServerDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
  const { normalizeAccountSettingsForServerStorage } = await import('@/sync/domains/settings/accountSettingsNormalization');
  const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
  const { sync } = await import('@/sync/sync');
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
  const { createAccountVoiceOperationService } = await import('@/voice/credentials/accountVoiceOperationService');
  const { createVoiceClientAccountOperationExecutor } = await import('@/voice/credentials/mediatedCredentialClient');
  const { resolveVoiceExecutionMachineId, isCapturedVoiceExecutionMachineCurrent } = await import('@/voice/settings/executionMachine');
  const { saveAndUseAccountVoiceCredential, applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
  const { createBundledVoiceRecipientContract } = await import('@/voice/credentials/voiceRecipientContract');
  const { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } = await import('@/voice/persistence/voiceTranscriptHistorySession');
  const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
  const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
  const { resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
  const { __resetVoiceTurnInterruptions } = await import('@/voice/transcript/voiceTurnInterruption');
  const { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } = await import('@/voice/registry/bundledConversationRuntimeHost');
  const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
  const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
  const { createBundledConversationRuntimeEntries } = await import('@/voice/registry/bundledConversationRuntimeEntries');

  const OPENAI_HISTORY_SESSION_ID = 'voice-history-openai-composed';
  const OPENAI_CREDENTIAL_MACHINE_ID = 'openai-credential-machine';
  const OPENAI_SOURCE_CREDENTIAL = 'sk_source_composed';
  let daemonAccountOperationTransport: OpenAiMintTransport;

  let transcriptRequest: ReturnType<typeof vi.fn>;
  let sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;
  let historySessionPost: (init: RequestInit) => Promise<Response>;
  let homeRequest: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response | null>;
  let allowedTranscriptMessageUrls: Set<string>;
  let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
  let purposes: ReturnType<typeof createConnectedPurposeCatalogHttpBoundary>;
  let persistedAccountSettings: ReturnType<typeof storage.getState>['settings'];
  let accountSettingsVersion = 1;
  let accountProfile = AccountProfileSchema.parse({ id: 'openai-composed-account' });

  function openAiEntry() {
    const entry = createBundledConversationRuntimeEntries(OPENAI_SOURCE_MANIFEST, activateOpenAiVoice)
      .find((candidate) => candidate.declaration.id === 'realtime-openai');
    if (!entry) throw new Error('realtime_openai bundled entry missing');
    return entry;
  }

  const configureOpenAiDaemonSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = socket => {
    // Only the external Socket.IO relay is replaced. Machine RPC scope, codecs,
    // purpose selection, Account operation admission and artifact parsing stay real.
      // The scoped pool may retain this cold transport beyond per-test spy restore.
      socket.connect = vi.fn<typeof socket.connect>(() => {
        if (socket.connected) return socket;
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
      });
      socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
      socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        const request = payload as Readonly<{ method: string; params: unknown }>;
        if (request.method !== `${OPENAI_CREDENTIAL_MACHINE_ID}:${RPC_METHODS.DAEMON_VOICE_CLIENT_ACCOUNT_OPERATION}`) {
          return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' };
        }
        const parsed = DaemonVoiceClientAccountOperationRequestV1Schema.parse(request.params);
        const responding = daemonAccountOperationTransport(parsed);
        notifyNetwork();
        let response: Awaited<ReturnType<OpenAiMintTransport>>;
        try { response = await responding; } finally { notifyNetwork(); }
        // The daemon contract carries only 2xx provider responses; a refused credential is a typed failure.
        if (response.status < 200 || response.status > 299) {
          return { ok: true, result: DaemonVoiceClientAccountOperationResponseV1Schema.parse({
            ok: false, errorCode: 'plugin_voice_credential_access_unavailable',
          }) };
        }
        return { ok: true, result: DaemonVoiceClientAccountOperationResponseV1Schema.parse({ ok: true,
          response: { status: response.status, finalUrl: response.finalUrl, headers: response.headers,
            bodyBase64: Buffer.from(response.body).toString('base64') },
        }) };
      });
  };

  function transcriptMessageUrl(sessionId: string): string {
    return `https://openai-composed.example.test/v2/sessions/${encodeURIComponent(sessionId)}/messages`;
  }

  function createOpenAiClientAuthProviderResponse(
    value: string,
    expiresAt: number,
  ) {
    return Object.freeze({
      value,
      expires_at: expiresAt,
      session: Object.freeze({
        type: 'realtime',
        object: 'realtime.session',
        id: 'sess_openai_composed_gate',
        model: 'gpt-realtime',
      }),
    });
  }

  function buildOpenAiSavedSecretSettings() {
    const { voice: _runtimeVoice, ...accountSettingsDefaults } = settingsDefaults;
    const entry = openAiEntry();
    const recipientContract = createBundledVoiceRecipientContract({
      pluginId: entry.pluginId,
      declaration: entry.declaration,
    });
    if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
    const voice = voiceSettingsParse({
      providerId: entry.providerId,
      providers: {
        [entry.providerId]: {
          schemaVersion: 1,
          config: {
            model: { kind: 'pinned', id: 'gpt-realtime' },
            voice: 'marin',
            instructions: '',
            turnDetection: 'server_vad',
            inputTranscriptionModel: '',
          },
        },
      },
    });
    const credentialInput = {
      settings: settingsParse({
        ...accountSettingsDefaults,
        voiceSettingsV1: voice,
      }),
      contribution: {
        pluginId: entry.pluginId,
        localId: entry.declaration.id,
      },
      credentialSlotId: recipientContract.credentialSlot.id,
      expectedSettingsVersion: 1,
      currentDeclaration: entry.declaration,
      value: OPENAI_SOURCE_CREDENTIAL,
      generateId: () => 'realtime-openai-composed-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest:
        createRecipientContractDigestV1(recipientContract),
    };
    const selected = applyAccountVoiceCredentialSourceSelection({
      settings: saveAndUseAccountVoiceCredential(credentialInput).settings,
      connectedPurposes: { v: 1, bindings: [] },
      currentDeclaration: entry.declaration,
      mutation: { contribution: credentialInput.contribution, credentialSlotId: credentialInput.credentialSlotId,
        expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } },
    });
    return selected;
  }

  function buildOpenAiConnectedAccountSettings() {
    const { voice: _runtimeVoice, ...accountSettingsDefaults } = settingsDefaults;
    const voice = voiceSettingsParse({
      providerId: 'happier.voice.openai/realtime-openai',
      credentialBindings: [{
        contribution: {
          pluginId: 'happier.voice.openai',
          localId: 'realtime-openai',
        },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: {},
      }],
      providers: {
        'happier.voice.openai/realtime-openai': {
          schemaVersion: 1,
          config: {
            model: { kind: 'pinned', id: 'gpt-realtime' },
            voice: 'marin',
            instructions: '',
            turnDetection: 'server_vad',
            inputTranscriptionModel: '',
          },
        },
      },
    });
    const settings = settingsParse({
      ...accountSettingsDefaults,
      voiceSettingsV1: voice,
    });
    return settings;
  }

  function installOpenAiFetchBoundary(): ReturnType<typeof vi.fn> {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/realtime/client_secrets')) {
        expect(new Headers(init?.headers).get('authorization'))
          .toBe(`Bearer ${OPENAI_SOURCE_CREDENTIAL}`);
        return new Response(JSON.stringify(createOpenAiClientAuthProviderResponse(
          'ek_source_composed',
          Math.floor(Date.now() / 1_000) + 60,
        )), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/realtime/calls')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer ek_source_composed',
        });
        return new Response('v=0\r\na=openai-answer\r\n', { status: 201 });
      }
      throw new Error(`unexpected OpenAI fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  async function createSourceComposedOpenAiRuntime(
    browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>,
    options?: OpenAiRuntimeOptions,
  ): Promise<OpenAiVoiceRuntime> {
    const hostLease = createBundledConversationRuntimeHostLease({ currentUiContext: options?.currentUiContext });
    if (options?.respondToDaemonAccountOperation) daemonAccountOperationTransport = options.respondToDaemonAccountOperation;
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const readPlaybackCursorMs = options?.readPlaybackCursorMs;
    let observedController: ReturnType<typeof hostLease.host.createConversationController> | null = null;
    let requestReconnect: (() => Promise<boolean>) | null = null;
    const baseHost = Object.freeze({
      ...hostLease.host,
      // Node resolution selects the native factory; select the real WebMicSession
      // producer with the caller's callbacks and the installed browser SDK inputs.
      createMicSession: browser.createMicSession,
      createConversationController: (
        input: Parameters<typeof hostLease.host.createConversationController>[0],
      ) => {
        const controller = hostLease.host.createConversationController(input);
        observedController = controller;
        requestReconnect = () => controller.requestReconnect();
        return controller;
      },
    });
    const host = Object.freeze({
      ...baseHost,
      ...(readPlaybackCursorMs
        ? {
            createWebRtcConnection: (
              input: Parameters<typeof baseHost.createWebRtcConnection>[0],
            ) => {
              const connection = baseHost.createWebRtcConnection(input);
              return Object.freeze({
                ...connection,
                playbackCursorMs: readPlaybackCursorMs,
              });
            },
          }
        : {}),
    });
    const entry = openAiEntry();
    const providerId = entry.providerId;
    const recipientContract = createBundledVoiceRecipientContract({
      pluginId: entry.pluginId,
      declaration: entry.declaration,
    });
    if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
    const initialConversationSessionId = options?.initialConversationSessionId
      ?? OPENAI_HISTORY_SESSION_ID;
    voiceSessionBindingStore.getState().bind({
      adapterId: providerId,
      controlSessionId,
      conversationSessionId: initialConversationSessionId,
      conversationSessionAddress: {
        serverId: getActiveServerSnapshot().serverId,
        sessionId: initialConversationSessionId,
      },
      lifetime: 'runtime_attempt',
      transcriptMode: 'synthetic',
      targetSessionAddress: null,
      updatedAt: 1,
    });
    const requestAccountOperation = vi.fn();
    const scope = createExternalVoiceProviderActivationScope({
      pluginId: entry.pluginId,
      occurrenceId: `${entry.pluginId}-activation-occurrence`,
      declarations: [entry.declaration],
      hostPlatform: 'web',
      runtimeHost: host,
      isRuntimeHostCurrent: () =>
        getCurrentBundledConversationRuntimeHost() === hostLease.host,
      hostBindingsByLocalId: Object.freeze({
        [entry.declaration.id]: Object.freeze({
          recipientContract,
          createInvocationAccountOperations: (
            signal: AbortSignal,
            _conversationSessionId: string | null,
            isCurrent: () => boolean,
            phase: 'settings' | 'prepare' | 'connection',
          ) => {
            const machineId = resolveVoiceExecutionMachineId();
            const accountOperations = createAccountVoiceOperationService({
              providerId,
              contribution: {
                pluginId: entry.pluginId,
                localId: entry.declaration.id,
              },
              declaration: entry.declaration,
              phase,
              recipientContract,
              signal,
              isCurrent,
              executeConnectedAccountOperation: createVoiceClientAccountOperationExecutor({
                contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
                platform: 'web', phase, declarationAuthority: { kind: 'bundled' }, machineId,
                isCurrent, isInvocationCurrent: () => isCapturedVoiceExecutionMachineCurrent(machineId),
              }),
            });
            return Object.freeze({
              request: (input: Parameters<typeof accountOperations.request>[0]) => {
                requestAccountOperation(input);
                return accountOperations.request(input);
              },
            });
          },
          descriptor: 'bundled' as const,
        }),
      }),
    });
    entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
    await scope.commit();
    const registration = getExternalVoiceProviderRegistration(
      providerId,
    );
    if (!registration?.adapter) {
      throw new Error('realtime_openai bundled activation failed');
    }
    const runtime = Object.freeze({
      adapter: registration.adapter,
      async dispose() {
        await scope.unwind();
      },
    });
    registerVoiceAdapters([runtime.adapter]);
    return Object.freeze({
      controlSessionId,
      historySessionId: initialConversationSessionId,
      adapter: runtime.adapter,
      get controller() { return observedController; },
      hostLease,
      requestAccountOperation,
      async requestReconnect() {
        const request = requestReconnect;
        if (!request) throw new Error('voice conversation controller unavailable');
        return await request();
      },
      runtime,
    });
  }

  const selectConnectedAccount = async (accountId: string | null): Promise<void> => {
    const selected = applyAccountVoiceCredentialSourceSelection({
      settings: storage.getState().settings, connectedPurposes: purposes.value, currentDeclaration: openAiEntry().declaration,
      mutation: { contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' }, credentialSlotId: 'api_key',
        expectedSettingsVersion: 1, selection: accountId ? { kind: 'connectedAccount', target: { kind: 'account',
          account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId } } } : { kind: 'none' } },
    });
    await publishAccountSettings(selected.settings);
    purposes.replace(selected.connectedPurposes);
    await purposes.hydrate({ serverId: getActiveServerSnapshot().serverId, accountId: 'openai-composed-account' });
    storage.getState().applyMachines([createMachineFixture({ id: OPENAI_CREDENTIAL_MACHINE_ID, activeAt: Date.now() })], true,
      { sourceServerId: getActiveServerSnapshot().serverId });
  };

    const browserStorage = typeof globalThis.localStorage === 'undefined' ? installLocalStorageMock() : null;
    daemonAccountOperationTransport = async () => { throw new Error('Unexpected daemon mint transport'); };
    purposes = createConnectedPurposeCatalogHttpBoundary();
    await resetServerReachabilitySupervisors();
    const server = await upsertServerProfileOnly({
      serverUrl: 'https://openai-composed.example.test',
      name: 'OpenAI composed test',
    });
    // Each restored Account gets a fresh catalog observation; an intentionally
    // retired previous case must not leave a retained loader flight in this one.
    resetConnectedAccountCatalogEngineForTests();
    resetConnectedAccountCatalogSnapshotsForTests();
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    __resetVoiceTurnInterruptions();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    const savedSecret = options.credentialSource === 'connectedAccount' ? null : buildOpenAiSavedSecretSettings();
    persistedAccountSettings = savedSecret?.settings ?? buildOpenAiConnectedAccountSettings();
    purposes = createConnectedPurposeCatalogHttpBoundary({ initialValue: savedSecret?.connectedPurposes ?? { v: 1, bindings: [] } });
    if (options.voice !== undefined) {
      persistedAccountSettings = applySettings(persistedAccountSettings, normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse(options.voice) }, persistedAccountSettings));
    }
    const historySession = createSessionFixture({
      id: OPENAI_HISTORY_SESSION_ID, serverId: server.id, active: false, encryptionMode: 'plain',
      metadata: { path: '/voice-transcript-history', host: 'happier.test', ...buildVoiceTranscriptHistorySessionMetadata() },
    });
    sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const carrierMetadata = historySession.metadata;
    const carrierOwner = createSessionOwnerMetadataV1({ metadata: carrierMetadata });
    if (!carrierOwner.ok) throw new Error('Expected supported Voice carrier owner metadata');
    sessionHttp.createSessionFromPost(OPENAI_HISTORY_SESSION_ID, { method: 'POST', body: JSON.stringify({
      tag: 'system:voice-transcript-history:v1', metadataLayoutVersion: 1,
      sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: carrierMetadata, agentState: null })) },
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(carrierOwner.ownerMetadata),
      agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
    }) });
    historySessionPost = async init => sessionHttp.createSessionFromPost(OPENAI_HISTORY_SESSION_ID, init);
    const providerFetch = installOpenAiFetchBoundary();
    allowedTranscriptMessageUrls = new Set([
      transcriptMessageUrl(OPENAI_HISTORY_SESSION_ID),
    ]);
    let nextTranscriptSeq = 0;
    homeRequest = createSessionReadBatchFetchBoundary(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).pathname === '/v1/account/profile') return Response.json(accountProfile);
      if (new URL(url).pathname === '/v2/account/settings') return Response.json({ version: accountSettingsVersion, content: { t: 'plain',
        v: normalizeAccountSettingsForServerStorage({ raw: persistedAccountSettings, mode: 'plain',
          settingsSecretsKey: null, normalizeServerRaw: normalizeVoiceSettingsServerDelta }).value } });
      if (new URL(url).pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: OPENAI_CREDENTIAL_MACHINE_ID, accountId: 'openai-composed-account' })]);
      if (new URL(url).pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => id === OPENAI_CREDENTIAL_MACHINE_ID ? createPlainMachineRowFixture({ id, accountId: 'openai-composed-account' }) : null);
      if (new URL(url).pathname === `/v1/machines/${OPENAI_CREDENTIAL_MACHINE_ID}`) return Response.json({ machine: createPlainMachineRowFixture({ id: OPENAI_CREDENTIAL_MACHINE_ID, accountId: 'openai-composed-account' }) });
      if (/^\/v[123]\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname) && (init?.method ?? 'GET') === 'GET') return Response.json({ messages: [], hasMore: false });
      if (new URL(url).pathname === '/v1/sessions' && init?.method === 'POST') return historySessionPost(init);
      if (new URL(url).pathname === '/v2/sessions/lookup-by-tags') {
        const request = SessionLookupByTagsRequestV2Schema.parse(JSON.parse(String(init?.body)));
        expect(request.tags).toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
        const detail = sessionHttp.handle(`https://openai-composed.example.test/v2/sessions/${OPENAI_HISTORY_SESSION_ID}`);
        if (!detail) throw new Error('Missing persisted history detail response');
        const sessions = detail.ok ? [V2SessionByIdResponseSchema.parse(await detail.json()).session] : [];
        return Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions }));
      }
      const sessionResponse = sessionHttp.handle(input, init);
      if (sessionResponse) return sessionResponse;
      const purposeResponse = await purposes.handle(input, init);
      if (purposeResponse) return purposeResponse;
      const preparation = answerVoiceRealtimePreparationHttpRequest(input, persistedAccountSettings);
      if (preparation) return preparation;
      return null;
    });
    transcriptRequest = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!allowedTranscriptMessageUrls.has(url)) return Response.json({ error: 'not_found' }, { status: 404 });
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    accountConnection = await restoreServerAccountForTest({
      serverUrl: server.serverUrl,
      accountId: 'openai-composed-account',
      credentialScope: 'restored-home',
      // Cold restore is boot-only. This reusable recipe can follow a retained
      // Account transport after its prior content lifetime has been retired.
      activation: apiSocket.getMachineRequestScope() ? 'switch' : undefined,
      configureSocket: configureOpenAiDaemonSocket,
      request: async (input, init) => {
        // Keep domain bootstrap/refresh traffic outside the replaceable
        // transcript writer. The shared Home boundary owns unclaimed HTTP 404s.
        const path = new URL(String(input)).pathname;
        const responding = init?.method === 'POST' && /^\/v2\/sessions\/[^/]+\/messages$/.test(path)
          ? transcriptRequest(input, init)
          : homeRequest(input, init);
        notifyNetwork();
        try { return await responding; } finally { notifyNetwork(); }
      },
    });
    await sync.refreshAccountSettingsFromServer(accountSettingsVersion, storage.getState().settingsScope);
    storage.getState().applySessions([historySession]);
    storage.setState({ sessionMessages: {} });
    await purposes.hydrate({ serverId: server.id, accountId: 'openai-composed-account' });

  async function dispose() {
    await accountConnection?.dispose(); accountConnection = null;
    browserStorage?.restore();
    await resetServerReachabilitySupervisors();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    __resetVoiceTurnInterruptions();
    voiceConversationRuntimeMachine.reset();
  }

  async function publishAccountSettings(settings: ReturnType<typeof settingsParse>): Promise<void> {
    persistedAccountSettings = settings;
    accountSettingsVersion += 1;
    await sync.refreshAccountSettingsFromServer(accountSettingsVersion, storage.getState().settingsScope);
  }
  const configureVoice = async (input: unknown): Promise<void> => {
    const current = storage.getState().settings;
    await publishAccountSettings(applySettings(current, normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse(input) }, current)));
  };
  const installOpenAiSettings = async () => {
    const selected = buildOpenAiSavedSecretSettings();
    await publishAccountSettings(selected.settings);
    return selected.connectedPurposes;
  };
  const installOpenAiConnectedAccountSettings = async () => {
    await publishAccountSettings(buildOpenAiConnectedAccountSettings());
  };
  return {
    subscribeNetwork(notify) {
      networkEvents.addEventListener('network', notify);
      return () => networkEvents.removeEventListener('network', notify);
    },
    entry: openAiEntry(), historySessionId: OPENAI_HISTORY_SESSION_ID, credentialMachineId: OPENAI_CREDENTIAL_MACHINE_ID,
    providerFetch, transcriptMessageUrl, createClientAuthProviderResponse: createOpenAiClientAuthProviderResponse,
    accountConnection: accountConnection!, sessionHttp, purposes, transcriptRequest, homeRequest, allowedTranscriptMessageUrls,
    get accountProfile() { return accountProfile; },
    set accountProfile(value: ReturnType<typeof AccountProfileSchema.parse>) { accountProfile = AccountProfileSchema.parse(value); },
    get mintTransport() { return daemonAccountOperationTransport; },
    set mintTransport(value: OpenAiMintTransport) { daemonAccountOperationTransport = value; },
    get persistedAccountSettings() { return persistedAccountSettings; },
    set persistedAccountSettings(value) { persistedAccountSettings = value; },
    get historySessionPost() { return historySessionPost; },
    set historySessionPost(value) { historySessionPost = value; },
    publishAccountSettings, configureVoice, selectConnectedAccount, installSavedSecretSettings: installOpenAiSettings, installConnectedAccountSettings: installOpenAiConnectedAccountSettings,
    createRuntime: createSourceComposedOpenAiRuntime, dispose,
  };
}

