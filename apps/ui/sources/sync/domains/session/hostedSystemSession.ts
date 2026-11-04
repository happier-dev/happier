import { SESSION_METADATA_LAYOUT_VERSION_V1, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, type SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectSessionDisplayV1, addSessionInitialAccessTeamShareStatement,
    materializeSessionInitialAccessCreateFields, resolveVerifiedSessionRecipientContentPublicKey,
    SessionInitialAccessEnvelopeHostError, type SessionDisplayProjectionV1,
    type SessionInitialAccessMaterializedV1, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions';
import { decodeHex } from '@/encryption/hex';
import { readActionCredentialScopeDeniedHttpFailureV1, type ExternalActionExecutionAuthorizationV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Encryptor } from '@/sync/encryption/encryptor';
import { createResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { createSessionDisplayCrypto } from '@/sync/encryption/sessionDisplayCrypto';
import type {
    ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

type HostedSystemSessionEncryption = Readonly<{
    openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor>;
    encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array | null>;
}>;

export type SessionCreateOrLoadInput = Readonly<{
    credentials: AuthCredentials;
    accountMode: 'plain' | 'e2ee';
    encryption: HostedSystemSessionEncryption | null;
    tag: string;
    metadata: Readonly<Record<string, unknown>>;
    organizationPlacement?: SessionSpawnNewInputV2['organizationPlacement'];
    initialAccess?: SessionSpawnNewInputV2['initialAccess'];
    primaryTeamId?: SessionSpawnNewInputV2['primaryTeamId'];
    teamCredentialBindings?: SessionSpawnNewInputV2['teamCredentialBindings'];
    manager?: SessionSpawnNewInputV2['manager'];
    randomBytes(length: number): Uint8Array;
    request(path: string, init: RequestInit): Promise<Response>;
    assertCurrent(): void;
    /** Private admitted requester proof; absent from public Session authoring input. */
    templateRequesterAuthorization?: Readonly<{
        authorization: ExternalActionExecutionAuthorizationV1;
        originalActionEnvelope: ExternalActionRequestEnvelope;
    }>;
    onCreationAuthorization?(authorization: ExternalActionExecutionAuthorizationV1): void;
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
    templateRequesterAuthorization?: SessionCreateOrLoadInput['templateRequesterAuthorization'];
    tag: string;
    organizationPlacement?: SessionSpawnNewInputV2['organizationPlacement'];
    initialAccess?: SessionInitialAccessMaterializedV1;
    primaryTeamId?: SessionSpawnNewInputV2['primaryTeamId'];
    teamCredentialBindings?: SessionSpawnNewInputV2['teamCredentialBindings'];
    manager?: SessionSpawnNewInputV2['manager'];
    metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
    sharedMetadata: Readonly<{ ciphertext: string }>;
    ownerMetadata: SessionOwnerMetadataEnvelopeV1;
    displayProjectionV1: SessionDisplayProjectionV1;
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
    const accessFields = {
        ...(input.initialAccess === undefined ? {} : { initialAccess: input.initialAccess }),
        ...(input.primaryTeamId === undefined ? {} : { primaryTeamId: input.primaryTeamId }),
    };
    const metadata = addSessionInitialAccessTeamShareStatement(input.metadata, accessFields, input.accountMode);
    const buildAccess = async (sessionDataKey: Uint8Array | null) => ({
        ...(input.organizationPlacement === undefined ? {} : { organizationPlacement: input.organizationPlacement }),
        ...(input.teamCredentialBindings === undefined ? {} : { teamCredentialBindings: input.teamCredentialBindings }),
        ...(input.manager === undefined ? {} : { manager: input.manager }),
        ...await materializeSessionInitialAccessCreateFields({ fields: accessFields, sessionEncryptionMode: input.accountMode,
            sessionDataKey, randomBytes: input.randomBytes,
            resolveRecipientContentPublicKey: async accountId => {
                input.assertCurrent();
                const response = await input.request(`/v1/user/${encodeURIComponent(accountId)}`, {
                    method: 'GET', headers: { Authorization: `Bearer ${input.credentials.token}` },
                });
                input.assertCurrent();
                if (response.status === 401 || response.status === 403) throw new SessionInitialAccessEnvelopeHostError('not_authenticated', response.status);
                if (response.status === 404) throw new SessionInitialAccessEnvelopeHostError('session_access_subject_not_found', response.status);
                if (!response.ok) throw new SessionInitialAccessEnvelopeHostError('session_access_request_failed', response.status);
                return resolveVerifiedSessionRecipientContentPublicKey(await response.json(), decodeHex);
            },
        }),
    });
    const sharedMetadata = projectSessionSharedMetadataV1({
        metadata,
        agentState: null,
    });
    const ownerMetadata = createSessionOwnerMetadataV1({
        metadata,
    });
    if (!ownerMetadata.ok) {
        throw createMetadataPrivacyUpgradeRequiredError(
            ownerMetadata.unsupportedFields,
        );
    }
    const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata: ownerMetadata.ownerMetadata });
    const ownerDisplay = display.owner;
    if (!ownerDisplay) throw new Error('Hosted system session owner display projection failed');
    const buildDisplayProjection = async (encryptor?: Encryptor): Promise<SessionDisplayProjectionV1> => {
        const crypto = createSessionDisplayCrypto({
            sessionMode: input.accountMode,
            accountMode: input.accountMode,
            credentials: input.credentials,
            sessionEncryption: encryptor ? {
                encryptRaw: async (payload) => {
                    const [encrypted] = await encryptor.encrypt([payload]);
                    if (!encrypted) throw new Error('Hosted system session display encryption failed');
                    return encodeBase64(encrypted, 'base64');
                },
            } : null,
        });
        return {
            v: 1,
            sourceMetadataVersion: 0,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            shared: await crypto.encodeSharedDisplay(display.shared),
            owner: crypto.encodeOwnerDisplay(ownerDisplay),
        };
    };
    if (input.accountMode === 'plain') {
        return {
            ...await buildAccess(null),
            tag: input.tag,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            sharedMetadata: {
                ciphertext: JSON.stringify(sharedMetadata),
            },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                ownerMetadata.ownerMetadata,
            ),
            displayProjectionV1: await buildDisplayProjection(),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        };
    }

    const encryption = input.encryption;
    if (!encryption) {
        throw new Error('Account encryption material is required to create an E2EE hosted system session');
    }
    const resourceKey = await createResourceDataKey({
        mode: 'e2ee',
        encryptDataEncryptionKey: (dataKey) =>
            encryption.encryptEncryptionKey(dataKey),
    });
    if (!resourceKey || resourceKey.mode !== 'e2ee') {
        throw new Error('Account encryption material is required to create an E2EE hosted system session');
    }
    const encryptor = await encryption.openEncryption(resourceKey.dataKey);
    const [encryptedSharedMetadata] = await encryptor.encrypt([sharedMetadata]);
    if (!encryptedSharedMetadata) {
        throw new Error('Hosted system session metadata encryption failed');
    }

    return {
        ...await buildAccess(resourceKey.dataKey),
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
        displayProjectionV1: await buildDisplayProjection(encryptor),
        agentState: null,
        dataEncryptionKey: resourceKey.dataEncryptionKey,
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
        method: 'POST', headers, body: JSON.stringify({ ...body,
            ...(input.templateRequesterAuthorization ? { templateRequesterAuthorization: input.templateRequesterAuthorization } : {}),
        }),
    });
    const responsePayload: unknown = await response.json().catch(() => null);
    input.assertCurrent();
    const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, responsePayload);
    if (scopeDenial) throw new HappyError(scopeDenial.error, false, {
        status: response.status, kind: 'auth', code: scopeDenial.errorCode,
    });
    if (!response.ok) throw new Error(`Session create/load failed (${response.status})`);
    const parsed = V2SessionByIdResponseSchema.safeParse(responsePayload);
    if (!parsed.success || parsed.data.session.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || parsed.data.session.ownerMetadata == null || !Object.hasOwn(parsed.data.session, 'agentState')) {
        throw new Error('Invalid Session create/load response');
    }
    const created = responsePayload !== null && typeof responsePayload === 'object'
        ? Reflect.get(responsePayload, 'created') : undefined;
    if (typeof created !== 'boolean') throw new Error('Invalid Session create/load disposition');
    const birthAuthorization = response.headers.get(TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1);
    if (birthAuthorization && input.onCreationAuthorization) {
        const authorization = decodeTemplateBirthExecutionAuthorizationV1(birthAuthorization);
        if (!authorization) throw new Error('Invalid Session birth authorization');
        input.onCreationAuthorization(authorization);
    }
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
