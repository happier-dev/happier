import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type {
    RegisteredVoiceProviderRuntime,
    VoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/voice';
import type {
    RealtimeVoiceProviderRuntime,
    VoiceClientAuthArtifact,
} from '@happier-dev/plugin-sdk/voice/client';
import type { VoiceProviderCatalogItem } from '@happier-dev/plugin-sdk/voice/speech';

import { openReviewStatus } from './ui/reviewClientActions.js';

const VOICE_CLIENT_AUTH_URL = 'https://voice.example.test/v1/session';
const VOICE_CATALOG_URL = 'https://voice.example.test/v1/catalog';
const VOICE_CLIENT_AUTH_RESPONSE_MAX_BYTES = 32_768;
const VOICE_CATALOG_RESPONSE_MAX_BYTES = 2_097_152;
const CURRENT_UI_READ_RESPONSE_PREFIX = 'public-authoring-current-ui-read-response-';
const CURRENT_UI_INVOKE_RESPONSE_PREFIX = 'public-authoring-current-ui-invoke-response-';
const CURRENT_UI_READ_CALL_PREFIX = 'public-authoring-current-ui-read-call-';
const CURRENT_UI_INVOKE_CALL_PREFIX = 'public-authoring-current-ui-invoke-call-';
const CURRENT_UI_CONTEXT_CONFORMANCE_TEXT = 'run current UI context conformance';

type ProviderManagedInputCapture = Readonly<{
    setMuted(muted: boolean): void;
    isMuted(): boolean;
}>;

function createProviderManagedInputCapture(): ProviderManagedInputCapture {
    let muted = false;
    return Object.freeze({
        setMuted(nextMuted: boolean) {
            muted = nextMuted;
        },
        isMuted() {
            return muted;
        },
    });
}

async function* emptyEvents<T>(): AsyncIterable<T> {
    return;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
    return typeof value === 'string'
        && value.trim() === value
        && value.length > 0
        && value.length <= maxLength
        ? value
        : null;
}

function readCurrentUiCommandId(value: unknown): string | null {
    const commands = readRecord(value)?.commands;
    if (!Array.isArray(commands)) return null;
    return readBoundedString(readRecord(commands[0])?.id, 512);
}

function readCurrentUiToolResult(value: unknown): Readonly<{
    responseId: string;
    commandId: string;
}> | null {
    const results = readRecord(value)?.results;
    if (!Array.isArray(results)) return null;
    for (const result of results) {
        const record = readRecord(result);
        if (record?.status !== 'success') continue;
        const responseId = readBoundedString(record.responseId, 512);
        const commandId = readCurrentUiCommandId(record.output);
        if (!responseId || !commandId || !responseId.startsWith(CURRENT_UI_READ_RESPONSE_PREFIX)) {
            return null;
        }
        const callId = responseId.replace(CURRENT_UI_READ_RESPONSE_PREFIX, CURRENT_UI_READ_CALL_PREFIX);
        if (record.callId !== callId) continue;
        return { responseId, commandId };
    }
    return null;
}

function readResponseContinuation(value: unknown): string | null {
    const record = readRecord(value);
    return record?.type === 'response_continue'
        ? readBoundedString(record.responseId, 512)
        : null;
}

function isCurrentUiContextConformanceText(value: unknown): boolean {
    const record = readRecord(value);
    return record?.type === 'input_text'
        && record.text === CURRENT_UI_CONTEXT_CONFORMANCE_TEXT;
}

function createToolCallControl(input: Readonly<{
    responseId: string;
    callId: string;
    toolName: 'readCurrentUiContext' | 'invokeCurrentUiCommand';
    arguments: Readonly<Record<string, string>>;
}>) {
    return {
        type: 'tool_call' as const,
        responseId: input.responseId,
        callId: input.callId,
        toolName: input.toolName,
        arguments: input.arguments,
    };
}

function decodeToolCallControl(value: unknown) {
    const record = readRecord(value);
    if (record?.type !== 'tool_call') return [];
    const responseId = readBoundedString(record.responseId, 512);
    const callId = readBoundedString(record.callId, 512);
    const argumentsRecord = readRecord(record.arguments);
    if (!responseId || !callId || !argumentsRecord) return [];

    if (record.toolName === 'readCurrentUiContext') {
        if (Object.keys(argumentsRecord).length !== 0) return [];
        return [{
            type: 'tool_calls' as const,
            responseId,
            calls: [{
                v: 1 as const,
                responseId,
                callId,
                toolName: 'readCurrentUiContext',
                order: 0,
                arguments: {},
            }],
        }];
    }

    const commandId = record.toolName === 'invokeCurrentUiCommand'
        ? readBoundedString(argumentsRecord.commandId, 512)
        : null;
    if (!commandId || Object.keys(argumentsRecord).length !== 1) return [];
    return [{
        type: 'tool_calls' as const,
        responseId,
        calls: [{
            v: 1 as const,
            responseId,
            callId,
            toolName: 'invokeCurrentUiCommand',
            order: 0,
            arguments: { commandId },
        }],
    }];
}

function decodeAccountOperationJson(input: Readonly<{
    response: Awaited<ReturnType<VoiceAccountOperationService['request']>>;
    expectedFinalUrl: string;
    maxBytes: number;
}>): Readonly<Record<string, unknown>> {
    const contentType = input.response.headers['content-type']
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
    if (
        input.response.status < 200
        || input.response.status >= 300
        || input.response.finalUrl !== input.expectedFinalUrl
        || contentType !== 'application/json'
        || input.response.body.byteLength > input.maxBytes
    ) {
        throw new Error('voice_account_operation_response_invalid');
    }
    const decoded: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(input.response.body),
    );
    const record = readRecord(decoded);
    if (!record) {
        throw new Error('voice_account_operation_response_invalid');
    }
    return record;
}

function readClientAuthArtifact(value: unknown): VoiceClientAuthArtifact {
    const record = readRecord(value);
    if (
        record?.kind !== 'bearer_token'
        || record.placement !== 'authorization_header'
        || typeof record.value !== 'string'
        || record.value.length === 0
        || record.value.length > 16_384
        || typeof record.expiresAtMs !== 'number'
        || !Number.isInteger(record.expiresAtMs)
        || record.expiresAtMs <= 0
    ) {
        throw new Error('voice_client_auth_artifact_invalid');
    }
    return {
        kind: record.kind,
        value: record.value,
        expiresAtMs: record.expiresAtMs,
        placement: record.placement,
    };
}

function normalizeSyntheticClientAuth(upstream: Readonly<Record<string, unknown>>): VoiceClientAuthArtifact {
    const value = readBoundedString(upstream.sessionToken, 16_384);
    const expiresAtMs = upstream.expiresAtMs;
    if (!value || typeof expiresAtMs !== 'number' || !Number.isInteger(expiresAtMs) || expiresAtMs <= 0) {
        throw new Error('voice_client_auth_response_invalid');
    }
    return {
        kind: 'bearer_token',
        value,
        expiresAtMs,
        placement: 'authorization_header',
    };
}

export async function requestMediatedClientAuth(
    accountOperations: VoiceAccountOperationService,
    signal: AbortSignal,
): Promise<VoiceClientAuthArtifact> {
    const response = await accountOperations.request({
        operationId: 'client-auth',
        parameters: {},
        signal,
    });
    return normalizeSyntheticClientAuth(decodeAccountOperationJson({
        response,
        expectedFinalUrl: VOICE_CLIENT_AUTH_URL,
        maxBytes: VOICE_CLIENT_AUTH_RESPONSE_MAX_BYTES,
    }));
}

export async function requestMediatedVoiceCatalog(
    accountOperations: VoiceAccountOperationService,
    signal: AbortSignal,
): Promise<readonly VoiceProviderCatalogItem[]> {
    const response = await accountOperations.request({
        operationId: 'list-catalog',
        parameters: {},
        signal,
    });
    const upstream = decodeAccountOperationJson({
        response,
        expectedFinalUrl: VOICE_CATALOG_URL,
        maxBytes: VOICE_CATALOG_RESPONSE_MAX_BYTES,
    });
    if (!Array.isArray(upstream.voices) || upstream.voices.length > 500) {
        throw new Error('voice_catalog_response_invalid');
    }
    return upstream.voices.map((value) => {
        const voice = readRecord(value);
        const id = readBoundedString(voice?.voiceId, 256);
        const name = readBoundedString(voice?.displayName, 256);
        const locale = voice?.locale === undefined ? null : readBoundedString(voice.locale, 64);
        if (!voice || !id || !name || (voice.locale !== undefined && !locale)) {
            throw new Error('voice_catalog_response_invalid');
        }
        const metadata: VoiceProviderCatalogItem['metadata'] = locale ? { locale } : {};
        return {
            id,
            name,
            metadata,
        };
    });
}

const settingsOperations: NonNullable<RealtimeVoiceProviderRuntime['settingsOperations']> = {
    async listCatalog({ catalog, credentials, signal }) {
        if (catalog !== 'voices') {
            throw new Error('voice_catalog_unsupported');
        }
        if (!credentials.mediated) {
            throw new Error('voice_mediated_credentials_required');
        }
        return requestMediatedVoiceCatalog(credentials.mediated, signal);
    },
};

const accountMediatedBrowserRuntime = {
    kind: 'conversation',
    microphoneMode: 'provider_managed',
    protocol: {
        async prepare({ credentials, signal }) {
            if (!credentials.mediated) {
                throw new Error('voice_mediated_credentials_required');
            }
            const clientAuth = await requestMediatedClientAuth(credentials.mediated, signal);
            return {
                kind: 'prepared',
                session: {
                    config: { clientAuth },
                    safeMetadata: {},
                },
            } as const;
        },
        decodeControl(event) {
            return decodeToolCallControl(event);
        },
        encodeTurnControl() {
            return null;
        },
    },
    settingsOperations,
    async createConnection({ session, media, signal }) {
        // The value is a bounded, short-lived provider artifact. It is not the
        // account SavedSecret and should be passed directly into the provider
        // SDK according to `placement`, then dropped on terminal close.
        let clientAuth: VoiceClientAuthArtifact | null = readClientAuthArtifact(
            readRecord(session.config)?.clientAuth,
        );
        let connectionState: 'idle' | 'open' | 'closed' = 'idle';
        let emitControl: ((event: unknown) => void) | null = null;
        let nextCurrentUiResponse = 0;
        const pendingCurrentUiCommands = new Map<string, string>();
        const inputCapture = createProviderManagedInputCapture();
        activeAccountMediatedInputCapture = inputCapture;
        return media.createSdkHandleConnection({
            driver: {
                async open(input) {
                    throwIfAborted(input.signal);
                    if (!clientAuth) throw new Error('voice_client_auth_artifact_released');
                    emitControl = input.onControl;
                    connectionState = 'open';
                },
                async sendControl(event) {
                    if (connectionState !== 'open' || signal.aborted || !emitControl) return;
                    if (isCurrentUiContextConformanceText(event)) {
                        const responseId = `${CURRENT_UI_READ_RESPONSE_PREFIX}${++nextCurrentUiResponse}`;
                        // The provider responds through its ordinary inbound
                        // tool-call channel. The host owns tool execution.
                        emitControl(createToolCallControl({
                            responseId,
                            callId: responseId.replace(
                                CURRENT_UI_READ_RESPONSE_PREFIX,
                                CURRENT_UI_READ_CALL_PREFIX,
                            ),
                            toolName: 'readCurrentUiContext',
                            arguments: {},
                        }));
                        return;
                    }
                    const toolResult = readCurrentUiToolResult(event);
                    if (toolResult) {
                        pendingCurrentUiCommands.set(toolResult.responseId, toolResult.commandId);
                        return;
                    }
                    const responseId = readResponseContinuation(event);
                    if (!responseId) return;
                    const commandId = pendingCurrentUiCommands.get(responseId);
                    if (!commandId) return;
                    pendingCurrentUiCommands.delete(responseId);
                    const invokeResponseId = responseId.replace(
                        CURRENT_UI_READ_RESPONSE_PREFIX,
                        CURRENT_UI_INVOKE_RESPONSE_PREFIX,
                    );
                    if (invokeResponseId === responseId) return;
                    emitControl(createToolCallControl({
                        responseId: invokeResponseId,
                        callId: invokeResponseId.replace(
                            CURRENT_UI_INVOKE_RESPONSE_PREFIX,
                            CURRENT_UI_INVOKE_CALL_PREFIX,
                        ),
                        toolName: 'invokeCurrentUiCommand',
                        arguments: { commandId },
                    }));
                },
                async close() {
                    connectionState = 'closed';
                    pendingCurrentUiCommands.clear();
                    emitControl = null;
                    clientAuth = null;
                    if (activeAccountMediatedInputCapture === inputCapture) {
                        activeAccountMediatedInputCapture = null;
                    }
                },
            },
        });
    },
    setInputMuted(muted) {
        const inputCapture = activeAccountMediatedInputCapture;
        if (!inputCapture) throw new Error('voice_provider_input_capture_unavailable');
        inputCapture.setMuted(muted);
    },
    encodeToolResults: (results) => [{ type: 'tool_results', results }],
    encodeToolContinuation: (responseId) => ({ type: 'response_continue', responseId }),
    encodeContextUpdate: () => [],
    encodeTextTurn: (text) => [{ type: 'input_text', text }],
    outputLevelMeter: 'unavailable',
} satisfies RegisteredVoiceProviderRuntime;

let activeAccountMediatedInputCapture: ProviderManagedInputCapture | null = null;
let activeRawInputCapture: ProviderManagedInputCapture | null = null;

const rawBrowserRuntime = {
    kind: 'conversation',
    protocol: {
        async prepare({ signal }) {
            throwIfAborted(signal);
            return {
                kind: 'prepared',
                session: { config: {}, safeMetadata: {} },
            } as const;
        },
        decodeControl() {
            return [];
        },
        encodeTurnControl() {
            return null;
        },
    },
    async createConnection({ credentials, signal }) {
        if (!credentials.raw) {
            throw new Error('voice_raw_credentials_required');
        }
        await credentials.raw.materialize({
            kind: 'httpHeaders',
            origin: 'https://voice.example.test',
            headerNames: ['authorization'],
        }, { signal });
        throwIfAborted(signal);
        let connectionState: 'idle' | 'open' | 'closed' = 'idle';
        const inputCapture = createProviderManagedInputCapture();
        activeRawInputCapture = inputCapture;
        return {
            kind: 'sdk_handle',
            async connect(connectionSignal: AbortSignal) {
                throwIfAborted(connectionSignal);
                connectionState = 'open';
            },
            async sendControl() {},
            controlEvents: emptyEvents,
            transportEvents: emptyEvents,
            async close() {
                connectionState = 'closed';
                if (activeRawInputCapture === inputCapture) {
                    activeRawInputCapture = null;
                }
            },
            state: () => connectionState,
            currentProviderSessionId: () => null,
            playbackCursorMs: () => null,
            beginOutputInterruptionCandidate: () => 'unsupported' as const,
            resolveOutputInterruptionCandidate() {},
        } as const;
    },
    encodeToolResults: () => [],
    encodeToolContinuation: () => ({}),
    encodeContextUpdate: () => [],
    encodeTextTurn: () => [],
    outputLevelMeter: 'unavailable',
    microphoneMode: 'provider_managed',
    setInputMuted(muted) {
        const inputCapture = activeRawInputCapture;
        if (!inputCapture) throw new Error('voice_provider_input_capture_unavailable');
        inputCapture.setMuted(muted);
    },
} satisfies RealtimeVoiceProviderRuntime;

/** Generated web client entry for Voice leaves and the unsupported-platform fixture. */
export function activate(api: PluginClientApi): void {
    api.actions.register('open-review-status-web-only-fixture', openReviewStatus);
    api.voiceProviders.register('credentialed-browser', accountMediatedBrowserRuntime);
    api.voiceProviders.register('raw-browser', rawBrowserRuntime);
}
