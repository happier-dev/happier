import { V2SessionByIdResponseSchema } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Encryptor } from '@/sync/encryption/encryptor';
import type {
    ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

type HostedSystemSessionEncryption = Readonly<{
    openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor>;
    encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array>;
}>;

export type EnsureHostedSystemSessionInput = Readonly<{
    scopeKey: string;
    credentials: AuthCredentials;
    encryption: HostedSystemSessionEncryption;
    serverBasis: Readonly<{
        serverId: string;
        generation: number;
    }>;
    authority: ServerAccountSessionRequestAuthority;
    tag: string;
    metadata: Readonly<Record<string, unknown>>;
}>;

type HostedSystemSessionEnsurerDeps = Readonly<{
    fetchAccountEncryptionMode(
        credentials: AuthCredentials,
    ): Promise<Readonly<{ mode: 'plain' | 'e2ee' }>>;
    randomBytes(length: number): Uint8Array;
    request(
        path: string,
        init: RequestInit,
        authority: Readonly<{
            expectedActiveServer: EnsureHostedSystemSessionInput['serverBasis'];
        }>,
    ): Promise<Response>;
    hydrate(
        sessionId: string,
        authority: ServerAccountSessionRequestAuthority,
    ): Promise<EnsureSessionVisibleForRouteResult>;
    isScopeCurrent(scopeKey: string): boolean;
}>;

export type HostedSystemSessionEnsureResult = Readonly<{
    sessionId: string;
}>;

async function buildCreateBody(
    deps: HostedSystemSessionEnsurerDeps,
    input: EnsureHostedSystemSessionInput,
): Promise<Record<string, unknown>> {
    const accountMode = await deps.fetchAccountEncryptionMode(input.credentials);
    if (accountMode.mode === 'plain') {
        return {
            tag: input.tag,
            metadata: JSON.stringify(input.metadata),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        };
    }

    const dataEncryptionKey = 'encryption' in input.credentials
        ? deps.randomBytes(32)
        : null;
    const encryptor = await input.encryption.openEncryption(dataEncryptionKey);
    const [encryptedMetadata] = await encryptor.encrypt([input.metadata]);
    if (!encryptedMetadata) {
        throw new Error('Hosted system session metadata encryption failed');
    }

    return {
        tag: input.tag,
        metadata: encodeBase64(encryptedMetadata, 'base64'),
        agentState: null,
        dataEncryptionKey: dataEncryptionKey
            ? encodeBase64(
                await input.encryption.encryptEncryptionKey(dataEncryptionKey),
                'base64',
            )
            : null,
        encryptionMode: 'e2ee',
    };
}

export function createHostedSystemSessionEnsurer(deps: HostedSystemSessionEnsurerDeps): Readonly<{
    ensure(input: EnsureHostedSystemSessionInput): Promise<HostedSystemSessionEnsureResult>;
}> {
    const inFlightByScopeAndTag = new Map<string, Promise<HostedSystemSessionEnsureResult>>();

    const ensureOnce = async (
        input: EnsureHostedSystemSessionInput,
    ): Promise<HostedSystemSessionEnsureResult> => {
        if (!deps.isScopeCurrent(input.scopeKey)) {
            throw new Error('Hosted system session account scope changed');
        }
        const body = await buildCreateBody(deps, input);
        if (!deps.isScopeCurrent(input.scopeKey)) {
            throw new Error('Hosted system session account scope changed');
        }

        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.set('Authorization', `Bearer ${input.credentials.token}`);
        const response = await deps.request('/v1/sessions', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        }, {
            expectedActiveServer: input.serverBasis,
        });
        if (!response.ok) {
            throw new Error(`Hosted system session create/load failed (${response.status})`);
        }
        const parsed = V2SessionByIdResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
            throw new Error('Invalid hosted system session create/load response');
        }
        if (!deps.isScopeCurrent(input.scopeKey)) {
            throw new Error('Hosted system session account scope changed');
        }

        const sessionId = parsed.data.session.id;
        const hydration = await deps.hydrate(sessionId, input.authority);
        if (
            hydration.kind !== 'available'
            || hydration.sessionId !== sessionId
        ) {
            throw new Error(`Hosted system session ${sessionId} could not be hydrated`);
        }
        if (!deps.isScopeCurrent(input.scopeKey)) {
            throw new Error('Hosted system session account scope changed');
        }
        return { sessionId };
    };

    return Object.freeze({
        ensure(input: EnsureHostedSystemSessionInput): Promise<HostedSystemSessionEnsureResult> {
            const scopeKey = input.scopeKey.trim();
            const tag = input.tag.trim();
            const serverId = input.serverBasis.serverId.trim();
            const generation = input.serverBasis.generation;
            if (
                !scopeKey
                || !tag
                || !serverId
                || !Number.isSafeInteger(generation)
                || generation < 0
            ) {
                return Promise.reject(new Error(
                    'Hosted system session scope, tag, and server basis are required',
                ));
            }
            const key = `${scopeKey}\u0000${tag}\u0000${serverId}\u0000${generation}`;
            const existing = inFlightByScopeAndTag.get(key);
            if (existing) return existing;

            const promise = ensureOnce({
                ...input,
                scopeKey,
                tag,
                serverBasis: { serverId, generation },
            });
            inFlightByScopeAndTag.set(key, promise);
            void promise.finally(() => {
                if (inFlightByScopeAndTag.get(key) === promise) {
                    inFlightByScopeAndTag.delete(key);
                }
            }).catch(() => undefined);
            return promise;
        },
    });
}
