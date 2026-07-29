import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
    PluginVoiceAccountOperationService,
    PluginVoiceProviderRuntimeRegistration,
    PluginVoiceProviderSettingsOperations,
} from '@happier-dev/plugin-sdk/runtime';

const VOICE_CLIENT_AUTH_URL = 'https://voice.example.test/v1/session';
const VOICE_CATALOG_URL = 'https://voice.example.test/v1/catalog';
const VOICE_CLIENT_AUTH_RESPONSE_MAX_BYTES = 32_768;
const VOICE_CATALOG_RESPONSE_MAX_BYTES = 2_097_152;

type VoiceClientAuthArtifact = Readonly<{
    kind: 'bearer_token';
    value: string;
    expiresAtMs: number;
    placement: 'authorization_header';
}>;

type VoiceCatalogItem = Readonly<{
    id: string;
    name: string;
    metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

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

function decodeAccountOperationJson(input: Readonly<{
    response: Awaited<ReturnType<PluginVoiceAccountOperationService['request']>>;
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
    accountOperations: PluginVoiceAccountOperationService,
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
    accountOperations: PluginVoiceAccountOperationService,
    signal: AbortSignal,
): Promise<readonly VoiceCatalogItem[]> {
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
        const metadata: VoiceCatalogItem['metadata'] = locale ? { locale } : {};
        return {
            id,
            name,
            metadata,
        };
    });
}

const settingsOperations: PluginVoiceProviderSettingsOperations = {
    async listCatalog({ catalog, accountOperations, signal }) {
        if (catalog !== 'voices') {
            throw new Error('voice_catalog_unsupported');
        }
        return requestMediatedVoiceCatalog(accountOperations, signal);
    },
};

const accountMediatedBrowserRuntime = {
    protocol: {
        async prepare({ accountOperations, signal }) {
            const clientAuth = await requestMediatedClientAuth(accountOperations, signal);
            return {
                kind: 'prepared',
                session: {
                    config: { clientAuth },
                    safeMetadata: {},
                },
            } as const;
        },
        decodeControl() {
            return [];
        },
        encodeTurnControl() {
            return null;
        },
    },
    settingsOperations,
    async createConnection({ session }) {
        // The value is a bounded, short-lived provider artifact. It is not the
        // account SavedSecret and should be passed directly into the provider
        // SDK according to `placement`, then dropped on terminal close.
        let clientAuth: VoiceClientAuthArtifact | null = readClientAuthArtifact(
            readRecord(session.config)?.clientAuth,
        );
        let connectionState: 'idle' | 'open' | 'closed' = 'idle';
        return {
            kind: 'sdk_handle',
            async connect(signal: AbortSignal) {
                signal.throwIfAborted();
                if (!clientAuth) throw new Error('voice_client_auth_artifact_released');
                connectionState = 'open';
            },
            async sendControl() {},
            controlEvents: emptyEvents,
            transportEvents: emptyEvents,
            async close() {
                connectionState = 'closed';
                clientAuth = null;
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
} satisfies PluginVoiceProviderRuntimeRegistration;

/** Generated web client entry named by `contributes.voiceProviders[].client`. */
export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
    api.voiceProviders.register('credentialed-browser', accountMediatedBrowserRuntime);
}
