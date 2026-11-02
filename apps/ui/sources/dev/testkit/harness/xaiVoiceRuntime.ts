import { expect, vi } from 'vitest';
export const XAI_VOICE_HISTORY_SESSION_ID = 'voice-history-xai-composed';
export class XaiVoiceWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: XaiVoiceWebSocket[] = [];
    private static readonly observers = new Set<() => void>();
    static subscribe(notify: () => void): () => void {
        XaiVoiceWebSocket.observers.add(notify);
        return () => { XaiVoiceWebSocket.observers.delete(notify); };
    }
    private static notify(): void {
        for (const observer of XaiVoiceWebSocket.observers) observer();
    }
    readyState: number = XaiVoiceWebSocket.CONNECTING;
    bufferedAmount = 0;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    constructor(readonly url: string, readonly protocols?: string | string[]) {
        XaiVoiceWebSocket.instances.push(this);
        XaiVoiceWebSocket.notify();
        this.emit('open');
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: unknown = {}): void {
        // WHATWG WebSockets §4: browser open/message/close notifications are
        // separate tasks, never reentrant callbacks inside send/open handling.
        setTimeout(() => {
            if (type === 'message' && this.readyState !== XaiVoiceWebSocket.OPEN)
                return;
            if (type === 'open') {
                if (this.readyState !== XaiVoiceWebSocket.CONNECTING)
                    return;
                this.readyState = XaiVoiceWebSocket.OPEN;
            }
            if (type === 'close')
                this.readyState = XaiVoiceWebSocket.CLOSED;
            for (const listener of this.listeners.get(type) ?? [])
                listener(event);
            XaiVoiceWebSocket.notify();
        }, 0);
    }
    send(value: string): void {
        // WHATWG send: CONNECTING throws; every non-throwing string send
        // accounts UTF-8 bytes, but CLOSING/CLOSED cannot transmit the data.
        if (this.readyState === XaiVoiceWebSocket.CONNECTING)
            throw new DOMException('WebSocket is still connecting', 'InvalidStateError');
        const byteLength = new TextEncoder().encode(value).byteLength;
        this.bufferedAmount += byteLength;
        if (this.readyState !== XaiVoiceWebSocket.OPEN)
            return;
        this.sent.push(value);
        XaiVoiceWebSocket.notify();
        setTimeout(() => {
            if (this.readyState !== XaiVoiceWebSocket.CLOSED)
                this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
        }, 0);
    }
    close(): void {
        if (this.readyState >= XaiVoiceWebSocket.CLOSING)
            return;
        this.readyState = XaiVoiceWebSocket.CLOSING;
        this.emit('close', { code: 1000, reason: '' });
    }
    emitConversationId(conversationId: string): void {
        this.emit('message', {
            data: JSON.stringify({
                type: 'conversation.created',
                conversation: { id: conversationId },
            }),
        });
    }
}
/** The incumbent generated xAI activation recipe; runtime owners load only after SDK boundaries are installed. */
export async function createXaiVoiceRuntimeEnvironment(options: Readonly<{
    historySessionId?: string;
}> = {}) {
    const networkEvents = new EventTarget();
    const notifyNetwork = () => networkEvents.dispatchEvent(new Event('network'));
    const { answerVoiceRealtimePreparationHttpRequest } = await import('@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary');
    const { createConnectedPurposeCatalogHttpBoundary } = await import('@/dev/testkit/harness/connectedAccountCatalogBoundary');
    const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
    const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
    const { createLiveMicSession } = await import('@/voice/runtime/mic/createLiveMicSession.web');
    const { installWebLockManagerMock, installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const { buildQualifiedPluginContributionKey, createPluginContributionIdentity, createRecipientContractDigestV1 } = await import('@happier-dev/protocol');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { settingsDefaults, settingsParse } = await import('@/sync/domains/settings/settings');
    const { normalizeAccountSettingsForLocalStorage } = await import('@/sync/domains/settings/accountSettingsNormalization');
    const { resolveSettingsSecretsKeySet } = await import('@/sync/encryption/resolveSettingsSecretsKeySet');
    const { storage } = await import('@/sync/domains/state/storage');
    const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
    const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createAccountVoiceOperationService } = await import('@/voice/credentials/accountVoiceOperationService');
    const { applyAccountVoiceCredentialSourceSelection, saveAndUseAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
    const { createBundledVoiceRecipientContract } = await import('@/voice/credentials/voiceRecipientContract');
    const { buildVoiceTranscriptHistorySessionMetadata } = await import('@/voice/persistence/voiceTranscriptHistorySession');
    const { writeVoiceProviderConversationMetadata } = await import('@/voice/persistence/voiceProviderConversationMetadata');
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
    const { resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
    const { XAI_REALTIME_DEFAULT_SETTINGS } = await import('../../../../../../packages/plugins/xai/src/protocol/voice/settings');
    const { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } = await import('@/voice/registry/bundledConversationRuntimeHost');
    const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
    const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
    await import('@/sync/syncEngine');
    const XAI_HISTORY_SESSION_ID = options.historySessionId ?? XAI_VOICE_HISTORY_SESSION_ID;
    const XAI_SOURCE_CREDENTIAL = 'xai_source_composed';
    let historyLookupSessionIds: readonly string[] = [];
    let xaiSessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;
    let persistedXaiSettings: ReturnType<typeof applyAccountVoiceCredentialSourceSelection>['accountSettings'];
    let xaiAccountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
    let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
    let webLocks: ReturnType<typeof installWebLockManagerMock> | null = null;
    let browserStorage: ReturnType<typeof installLocalStorageMock> | null = null;
    const audioContexts: InstanceType<typeof TestVoiceAudioContext>[] = [];
    let machineInventoryRequest: (() => Promise<Response>) | null = null;
    function readProviderConversationOwnerMetadata(sessionId: string) {
        const session = storage.getState().sessions[sessionId];
        return session ? readSessionOwnerMetadataView(session) : null;
    }
    function installProviderConversationMetadata(sessionId: string, conversationId: string): void {
        storage.setState((current) => {
            const session = current.sessions[sessionId];
            if (!session?.metadata)
                throw new Error(`missing session metadata ${sessionId}`);
            return {
                ...current,
                sessions: {
                    ...current.sessions,
                    [sessionId]: {
                        ...session,
                        [session.metadataLayoutVersion === 1 ? 'ownerMetadataView' : 'metadata']: writeVoiceProviderConversationMetadata(readSessionOwnerMetadataView(session), {
                            providerId: 'happier.voice.xai/realtime-grok',
                            state: { conversationId },
                            updatedAt: Date.now(),
                        }),
                    },
                },
            } as never;
        });
        xaiSessionHttp.replaceSession(sessionId);
    }
    function mockHistoryCarrierDiscovery(sessionIds: readonly string[] = [XAI_HISTORY_SESSION_ID]): void {
        historyLookupSessionIds = sessionIds;
    }
    function xaiEntry() {
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find((candidate) => candidate.declaration.id === 'realtime-grok');
        if (!entry)
            throw new Error('realtime_grok bundled entry missing');
        return entry;
    }
    let xaiPurposes: ReturnType<typeof createConnectedPurposeCatalogHttpBoundary>;
    async function installXaiSettings(resumptionEnabled: boolean): Promise<void> {
        const { voice: _runtimeVoiceProjection, ...accountSettingsDefaults } = settingsDefaults;
        const entry = xaiEntry();
        const recipientContract = createBundledVoiceRecipientContract({
            pluginId: entry.pluginId,
            declaration: entry.declaration,
        });
        if (!recipientContract)
            throw new Error('realtime_grok recipient contract missing');
        const voice = voiceSettingsParse({
            providerId: 'happier.voice.xai/realtime-grok',
            providers: {
                'happier.voice.xai/realtime-grok': {
                    schemaVersion: 1,
                    config: {
                        ...XAI_REALTIME_DEFAULT_SETTINGS,
                        resumptionEnabled,
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
            value: XAI_SOURCE_CREDENTIAL,
            generateId: () => 'realtime-xai-composed-secret',
            now: 1,
            expectedSecretId: null,
            expectedSecretUpdatedAt: null,
            approvedRecipientContractDigest: createRecipientContractDigestV1(recipientContract),
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: saveAndUseAccountVoiceCredential(credentialInput).settings, connectedPurposes: { v: 1, bindings: [] }, currentDeclaration: entry.declaration,
            mutation: { contribution: credentialInput.contribution, credentialSlotId: credentialInput.credentialSlotId,
                expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } },
        });
        // Serve the credential owner's persisted document at HTTP; the public
        // local-storage normalizer seals Plain Account secrets for this device.
        persistedXaiSettings = selected.accountSettings;
        const scope = storage.getState().settingsScope;
        if (!scope || !xaiAccountConnection)
            throw new Error('Expected the XAI fixture Account lifetime');
        const keys = await resolveSettingsSecretsKeySet({
            credentials: xaiAccountConnection.credentials,
            scope,
        });
        if (!keys)
            throw new Error('XAI fixture could not initialize device-local secret custody');
        const localSettings = normalizeAccountSettingsForLocalStorage({
            raw: selected.accountSettings,
            mode: 'plain',
            settingsSecretsKey: keys.writeKey,
            settingsSecretsReadKeys: keys.readKeys,
            localSettings: storage.getState().settings,
        });
        storage.getState().applySettingsLocal(localSettings);
        storage.setState((current) => ({
            ...current,
            sessions: {
                [XAI_HISTORY_SESSION_ID]: createSessionFixture({
                    id: XAI_HISTORY_SESSION_ID,
                    serverId: getActiveServerSnapshot().serverId,
                    active: false,
                    encryptionMode: 'plain',
                    metadata: {
                        path: '/voice-transcript-history',
                        host: 'happier.test',
                        ...buildVoiceTranscriptHistorySessionMetadata(),
                    },
                }),
            },
            sessionMessages: {},
        }) as never);
        xaiSessionHttp.replaceSession(XAI_HISTORY_SESSION_ID);
        xaiPurposes = createConnectedPurposeCatalogHttpBoundary({ initialValue: selected.connectedPurposes });
        await xaiPurposes.hydrate(scope);
    }
    function installXaiFetchBoundary(): ReturnType<typeof vi.fn> {
        const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/v1/tts/voices'))
                return Response.json({ voices: [{ voice_id: 'ara', name: 'Ara' }] });
            if (!url.endsWith('/v1/realtime/client_secrets')) {
                throw new Error(`unexpected xAI fetch: ${url}`);
            }
            expect(new Headers(init?.headers).get('authorization'))
                .toBe(`Bearer ${XAI_SOURCE_CREDENTIAL}`);
            const body = init?.body instanceof ArrayBuffer
                ? new TextDecoder().decode(new Uint8Array(init.body))
                : String(init?.body);
            expect(JSON.parse(body)).toEqual({
                expires_after: { seconds: 300 },
            });
            return new Response(JSON.stringify({
                value: 'source-composed',
                expires_at: Math.floor(Date.now() / 1000) + 60,
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetch);
        return fetch;
    }
    async function createSourceComposedXaiRuntime() {
        const hostLease = createBundledConversationRuntimeHostLease();
        const controlSessionId = hostLease.host.globalVoiceSessionId;
        let controller: ReturnType<typeof hostLease.host.createConversationController> | null = null;
        const host = Object.freeze({
            ...hostLease.host,
            // Select Metro's real browser mic owner in the Node source runner. Capture,
            // PCM encoding/scheduling and teardown remain in their canonical owners.
            createMicSession: createLiveMicSession,
            createConversationController: (input: Parameters<typeof hostLease.host.createConversationController>[0]) => {
                controller = hostLease.host.createConversationController(input);
                return controller;
            },
        });
        const entry = xaiEntry();
        const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: entry.pluginId,
            localId: entry.declaration.id,
        }));
        const recipientContract = createBundledVoiceRecipientContract({
            pluginId: entry.pluginId,
            declaration: entry.declaration,
        });
        if (!recipientContract)
            throw new Error('realtime_grok recipient contract missing');
        voiceSessionBindingStore.getState().bind({
            adapterId: providerId,
            controlSessionId,
            conversationSessionId: XAI_HISTORY_SESSION_ID,
            conversationSessionAddress: {
                serverId: getActiveServerSnapshot().serverId,
                sessionId: XAI_HISTORY_SESSION_ID,
            },
            lifetime: 'runtime_attempt',
            transcriptMode: 'synthetic',
            targetSessionAddress: null,
            updatedAt: 1,
        });
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: entry.pluginId,
            occurrenceId: `${entry.pluginId}-activation-occurrence`,
            declarations: [entry.declaration],
            hostPlatform: 'web',
            runtimeHost: host,
            isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
            hostBindingsByLocalId: Object.freeze({
                [entry.declaration.id]: Object.freeze({
                    recipientContract: createBundledVoiceRecipientContract({
                        pluginId: entry.pluginId,
                        declaration: entry.declaration,
                    }),
                    createInvocationAccountOperations: (signal: AbortSignal, _conversationSessionId: string | null, isCurrent: () => boolean, phase: 'settings' | 'prepare' | 'connection') => {
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
                        });
                        return accountOperations;
                    },
                    descriptor: 'bundled' as const,
                }),
            }),
        });
        const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
        (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
        await scope.commit();
        const registration = getExternalVoiceProviderRegistration(providerId);
        if (!registration?.adapter) {
            throw new Error('realtime_grok bundled activation failed');
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
            hostLease,
            providerFetch: vi.mocked(globalThis.fetch),
            getController() {
                if (!controller)
                    throw new Error('Actual xAI conversation controller has not been constructed');
                return controller;
            },
            runtime,
            requestReconnect: () => {
                if (!controller)
                    throw new Error('Actual xAI conversation controller has not been constructed');
                return controller.requestReconnect();
            },
            async dispose() {
                await runtime.dispose();
                hostLease.revoke();
            },
        });
    }
    xaiPurposes = createConnectedPurposeCatalogHttpBoundary();
    xaiSessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const { voice: _runtimeVoiceProjection, ...accountSettingsDefaults } = settingsDefaults;
    persistedXaiSettings = accountSettingsDefaults;
    await resetServerReachabilitySupervisors();
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
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
    XaiVoiceWebSocket.instances.length = 0;
    historyLookupSessionIds = [];
    audioContexts.length = 0;
    machineInventoryRequest = null;
    const AudioContextBoundary = class extends TestVoiceAudioContext {
        constructor() { super(); audioContexts.push(this); }
    };
    vi.stubGlobal('window', { AudioContext: AudioContextBoundary });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    browser = installVoiceWebRtcBrowserBoundary();
    // Consumers may select RN web explicitly. Supply only its missing browser
    // Storage SDK; real auth resolves and persists device-local key custody.
    if (typeof globalThis.localStorage?.getItem !== 'function')
        browserStorage = installLocalStorageMock();
    webLocks = installWebLockManagerMock();
    vi.stubGlobal('WebSocket', XaiVoiceWebSocket);
    installXaiFetchBoundary();
    let nextTranscriptSeq = 0;
    const accountRequest = createSessionReadBatchFetchBoundary(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (new URL(url).pathname === '/v1/machines') {
            return machineInventoryRequest ? await machineInventoryRequest() : Response.json([]);
        }
        if (/^\/v[123]\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname) && (init?.method ?? 'GET') === 'GET')
            return Response.json({ messages: [], hasMore: false });
        const purposeResponse = await xaiPurposes.handle(input, init);
        if (purposeResponse)
            return purposeResponse;
        const preparation = answerVoiceRealtimePreparationHttpRequest(input, persistedXaiSettings);
        if (preparation)
            return preparation;
        const sessionResponse = xaiSessionHttp.handle(input, init);
        if (sessionResponse)
            return sessionResponse;
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            return new Response('{}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url.endsWith('/v1/features')) {
            return Response.json({
                features: { voice: { enabled: true } },
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: 2,
                        currentProtocolVersion: 3,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            });
        }
        if (url.endsWith('/v2/sessions/lookup-by-tags')) {
            return Response.json({
                sessions: await Promise.all(historyLookupSessionIds.map(async (id) => {
                    const response = xaiSessionHttp.handle(`${getActiveServerSnapshot().serverUrl}/v2/sessions/${encodeURIComponent(id)}`);
                    if (!response?.ok)
                        throw new Error(`Missing history carrier HTTP fixture: ${id}`);
                    const body = await response.json();
                    return body.session;
                })),
            });
        }
        if (url !== `https://xai-composed.example.test/v2/sessions/${XAI_HISTORY_SESSION_ID}/messages`)
            return Response.json({ error: 'not_found' }, { status: 404 });
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body)) as Readonly<{
            localId: string;
        }>;
        nextTranscriptSeq += 1;
        return new Response(JSON.stringify({
            didWrite: true,
            message: {
                id: `xai-history-message-${nextTranscriptSeq}`,
                seq: nextTranscriptSeq,
                localId: body.localId,
                createdAt: Date.now(),
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    xaiAccountConnection = await restoreServerAccountForTest({ serverUrl: 'https://xai-composed.example.test', accountId: 'xai-composed-account', credentialScope: 'restored-home', request: async (input, init) => {
        const responding = accountRequest(input, init);
        notifyNetwork();
        try { return await responding; } finally { notifyNetwork(); }
    } });
    await xaiPurposes.hydrate({ serverId: xaiAccountConnection.home.id, accountId: 'xai-composed-account' });
    return {
        subscribeNetwork(notify: () => void) {
            networkEvents.addEventListener('network', notify);
            return () => networkEvents.removeEventListener('network', notify);
        },
        historySessionId: XAI_HISTORY_SESSION_ID,
        browser, audioContexts,
        physicalSockets: XaiVoiceWebSocket.instances,
        get providerFetch() { return vi.mocked(globalThis.fetch); },
        get sessionHttp() { return xaiSessionHttp; },
        get machineInventoryRequest() { return machineInventoryRequest; },
        set machineInventoryRequest(request: (() => Promise<Response>) | null) { machineInventoryRequest = request; },
        installSettings: installXaiSettings,
        createRuntime: createSourceComposedXaiRuntime,
        installProviderConversationMetadata, mockHistoryCarrierDiscovery, readProviderConversationOwnerMetadata, xaiEntry, installProviderFetchBoundary: installXaiFetchBoundary,
        async dispose() {
            await xaiAccountConnection?.dispose();
            xaiAccountConnection = null;
            browserStorage?.restore();
            browserStorage = null;
            webLocks?.restore();
            webLocks = null;
            await resetServerReachabilitySupervisors();
            browser.restore();
            vi.unstubAllGlobals();
            resetVoiceAdapterRegistryForTests();
            voiceConversationRuntimeMachine.reset();
        },
    };
}
export type XaiVoiceRuntimeEnvironment = Awaited<ReturnType<typeof createXaiVoiceRuntimeEnvironment>>;
