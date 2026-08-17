import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    V2SessionByIdResponseSchema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1,
    sealSessionOwnerMetadataEnvelopeV1,
    type SessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import {
    requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
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
    encryption: HostedSystemSessionEncryption | null;
    serverBasis: Readonly<{
        serverId: string;
        generation: number;
    }>;
    authority: ServerAccountSessionRequestAuthority;
    tag: string;
    metadata: Readonly<Record<string, unknown>>;
}>;

type HostedSystemSessionEnsurerDeps = Readonly<{
    fetchAccountEncryptionCurrentness(
        credentials: AuthCredentials,
        request: ServerAccountSessionRequestAuthority['request'],
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
    deps: HostedSystemSessionEnsurerDeps,
    input: EnsureHostedSystemSessionInput,
): Promise<HostedSystemSessionCreateBody> {
    const accountMode = await deps.fetchAccountEncryptionCurrentness(
        input.credentials,
        input.authority.request,
    );
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
    if (accountMode.mode === 'plain') {
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
        ? deps.randomBytes(32)
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
            randomBytes: deps.randomBytes,
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
        await requireCurrentAccountStoredContentServerCompatibility({
            serverId: input.serverBasis.serverId,
        });
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
        const responsePayload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(`Hosted system session create/load failed (${response.status})`);
        }
        const parsed = V2SessionByIdResponseSchema.safeParse(responsePayload);
        if (!parsed.success) {
            throw new Error('Invalid hosted system session create/load response');
        }
        if (
            parsed.data.session.metadataLayoutVersion
                !== SESSION_METADATA_LAYOUT_VERSION_V1
            || parsed.data.session.ownerMetadata == null
            || !Object.hasOwn(parsed.data.session, 'agentState')
        ) {
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
