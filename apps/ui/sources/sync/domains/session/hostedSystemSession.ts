import { SESSION_METADATA_LAYOUT_VERSION_V1, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, type SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Encryptor } from '@/sync/encryption/encryptor';
import type {
    ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

type HostedSystemSessionEncryption = Readonly<{
    openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor>;
    encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array>;
}>;

export type SessionCreateOrLoadInput = Readonly<{
    credentials: AuthCredentials;
    accountMode: 'plain' | 'e2ee';
    encryption: HostedSystemSessionEncryption | null;
    tag: string;
    metadata: Readonly<Record<string, unknown>>;
    randomBytes(length: number): Uint8Array;
    request(path: string, init: RequestInit): Promise<Response>;
    assertCurrent(): void;
}>;
export type SessionCreateOrLoadResult = Readonly<{
    session: V2SessionByIdResponse['session'];
    disposition: 'created' | 'rejoined';
}>;

export type EnsureHostedSystemSessionInput = Readonly<{
    scopeKey: string;
    credentials: AuthCredentials;
    encryption: HostedSystemSessionEncryption | null;
    serverBasis: Readonly<{
        serverId: string;
        generation: number;
    }>;
    authority: ServerAccountRequestAuthority;
    tag: string;
    metadata: Readonly<Record<string, unknown>>;
}>;

type HostedSystemSessionEnsurerDeps = Readonly<{
    fetchAccountEncryptionCurrentness(
        credentials: AuthCredentials,
        request: ServerAccountRequestAuthority['request'],
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
        authority: ServerAccountRequestAuthority,
    ): Promise<EnsureSessionVisibleForRouteResult>;
    isScopeCurrent(scopeKey: string): boolean;
}>;

export type HostedSystemSessionEnsureResult = Readonly<{
    sessionId: string;
}>;

type HostedSystemSessionCreateBody = Readonly<{
    tag: string;
    metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
    sharedMetadata: Readonly<{ ciphertext: string }>;
    ownerMetadata: SessionOwnerMetadataEnvelopeV1;
    agentState: null;
    dataEncryptionKey: string | null;
    encryptionMode: 'plain' | 'e2ee';
}>;

function createMetadataPrivacyUpgradeRequiredError(
    unsupportedFields: readonly string[],
): Error & {
    code: 'metadata_privacy_upgrade_required';
    retryable: false;
    unsupportedFields: readonly string[];
} {
    return Object.assign(
        new Error('Hosted system session metadata is not supported by layout 1'),
        {
            code: 'metadata_privacy_upgrade_required' as const,
            retryable: false as const,
            unsupportedFields,
        },
    );
}

async function buildCreateBody(
    input: SessionCreateOrLoadInput,
): Promise<HostedSystemSessionCreateBody> {
    const sharedMetadata = projectSessionSharedMetadataV1({
        metadata: input.metadata,
        agentState: null,
    });
    const ownerMetadata = createSessionOwnerMetadataV1({
        metadata: input.metadata,
    });
    if (!ownerMetadata.ok) {
        throw createMetadataPrivacyUpgradeRequiredError(
            ownerMetadata.unsupportedFields,
        );
    }
    if (input.accountMode === 'plain') {
        return {
            tag: input.tag,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            sharedMetadata: {
                ciphertext: JSON.stringify(sharedMetadata),
            },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                ownerMetadata.ownerMetadata,
            ),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        };
    }

    if (!input.encryption) {
        throw new Error('Account encryption material is required to create an E2EE hosted system session');
    }
    const dataEncryptionKey = 'encryption' in input.credentials
        ? input.randomBytes(32)
        : null;
    const encryptor = await input.encryption.openEncryption(dataEncryptionKey);
    const [encryptedSharedMetadata] = await encryptor.encrypt([sharedMetadata]);
    if (!encryptedSharedMetadata) {
        throw new Error('Hosted system session metadata encryption failed');
    }

    return {
        tag: input.tag,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        sharedMetadata: {
            ciphertext: encodeBase64(encryptedSharedMetadata, 'base64'),
        },
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
            material: resolveAccountScopedCryptoMaterialFromCredentials(
                input.credentials,
            ),
            ownerMetadata: ownerMetadata.ownerMetadata,
            randomBytes: input.randomBytes,
        }),
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

/** Existing UI Session POST owner; callers consume the server-selected create/rejoin row. */
export async function createSessionCreateOrLoad(input: SessionCreateOrLoadInput): Promise<SessionCreateOrLoadResult> {
    input.assertCurrent();
    const body = await buildCreateBody(input);
    input.assertCurrent();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Authorization', `Bearer ${input.credentials.token}`);
    const response = await input.request('/v1/sessions', {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    const responsePayload: unknown = await response.json().catch(() => null);
    input.assertCurrent();
    if (!response.ok) throw new Error(`Session create/load failed (${response.status})`);
    const parsed = V2SessionByIdResponseSchema.safeParse(responsePayload);
    if (!parsed.success || parsed.data.session.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || parsed.data.session.ownerMetadata == null || !Object.hasOwn(parsed.data.session, 'agentState')) {
        throw new Error('Invalid Session create/load response');
    }
    const created = responsePayload !== null && typeof responsePayload === 'object'
        ? Reflect.get(responsePayload, 'created') : undefined;
    if (typeof created !== 'boolean') throw new Error('Invalid Session create/load disposition');
    // A rejoin returns the actual row's envelope; the candidate key is never a launch result.
    return { session: parsed.data.session, disposition: created ? 'created' as const : 'rejoined' as const };
}

export function createHostedSystemSessionEnsurer(deps: HostedSystemSessionEnsurerDeps): Readonly<{
    ensure(input: EnsureHostedSystemSessionInput): Promise<HostedSystemSessionEnsureResult>;
}> {
    const inFlightByScopeAndTag = new Map<string, Promise<HostedSystemSessionEnsureResult>>();

    const ensureOnce = async (
        input: EnsureHostedSystemSessionInput,
    ): Promise<HostedSystemSessionEnsureResult> => {
        const assertCurrent = () => {
            if (!deps.isScopeCurrent(input.scopeKey)) throw new Error('Hosted system session account scope changed');
        };
        assertCurrent();
        const accountMode = await deps.fetchAccountEncryptionCurrentness(input.credentials, input.authority.request);
        const created = await createSessionCreateOrLoad({
            ...input, accountMode: accountMode.mode, randomBytes: deps.randomBytes, assertCurrent,
            request: (path, init) => deps.request(path, init, { expectedActiveServer: input.serverBasis }),
        });
        const sessionId = created.session.id;
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
