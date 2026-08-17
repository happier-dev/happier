import {
    isDataKeyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { decodeBase64 } from '@/encryption/base64';
import { randomUUID } from '@/platform/randomUUID';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    openAccountArtifactStoredEnvelope,
    createAccountArtifactStoredEnvelope,
    type AccountArtifactEnvelopeKeySealer,
    type AccountArtifactEnvelopeKeyOpener,
} from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type {
    PluginArtifactSourceCandidate,
} from '@/sync/domains/plugins/availability/artifactLease';
import {
    resolveAccountStoredContentCompatibilityHeaders,
    withAccountStoredContentCompatibilityRequestDeclaration,
    type AccountStoredContentCompatibilityHeaderResolution,
} from '@/sync/http/accountStoredContentCompatibility';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactPublishActionInputV1Schema,
    PluginAvailabilityUiArtifactPublishActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema,
    PluginAvailabilityUiArtifactReadActionOutputV1Schema,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    type PluginAvailabilityUiArtifactPublishActionInputV1,
    type PluginAvailabilityUiArtifactPublishActionOutputV1,
    type PluginAvailabilityUiArtifactReadActionInputV1,
    type PluginAvailabilityUiArtifactReadActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    createPluginUiArtifactArchiveV1,
    decodePluginUiArtifactArchiveBodyV1,
    encodePluginUiArtifactArchiveBodyV1,
    openPluginUiArtifactArchiveV1,
    type PluginUiArtifactArchiveOpenedV1,
} from '@happier-dev/protocol/plugins/ui';

type AccountHostedArtifactServerSnapshot = Readonly<{
    serverId: string | null;
    serverUrl: string;
    generation: number;
}>;

type AccountHostedArtifactRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    credentials?: AuthCredentials;
    decryptDataEncryptionKey?: AccountArtifactEnvelopeKeyOpener;
}>;

export type ActivePluginAccountHostedArtifactReadInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    release: PluginAvailabilityUiArtifactReadActionInputV1['release'];
    slot: Readonly<{
        contributionId: PluginAvailabilityUiArtifactReadActionInputV1['contributionId'];
        tier: PluginAvailabilityUiArtifactReadActionInputV1['tier'];
        platform: PluginAvailabilityUiArtifactReadActionInputV1['platform'];
    }>;
    expectedArtifactId: string;
    expectedArtifactDigest: string;
    signal?: AbortSignal;
}>;

/**
 * A prospective Account release slot is resolved by its exact release and
 * declared digest. Availability returns the canonical Artifact link only when
 * that slot currently exists, so callers never infer an Artifact id from an
 * incumbent intent or a marketplace record.
 */
export type ActivePluginAccountHostedArtifactTargetReadInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    release: PluginAvailabilityUiArtifactReadActionInputV1['release'];
    slot: Readonly<{
        contributionId: PluginAvailabilityUiArtifactReadActionInputV1['contributionId'];
        tier: PluginAvailabilityUiArtifactReadActionInputV1['tier'];
        platform: PluginAvailabilityUiArtifactReadActionInputV1['platform'];
    }>;
    expectedArtifactDigest: string;
    signal?: AbortSignal;
}>;

type ActivePluginAccountHostedArtifactUnavailableCode =
    | 'no_active_account_scope'
    | 'account_scope_changed'
    | 'server_generation_changed'
    | 'operation_cancelled'
    | 'stored_content_compatibility_unavailable'
    | 'account_currentness_unavailable'
    | 'account_encryption_material_unavailable'
    | 'response_identity_mismatch'
    | 'response_invalid'
    | 'artifact_envelope_unavailable'
    | 'artifact_archive_invalid'
    | 'source_archive_invalid'
    | 'transport_unavailable';

type ActivePluginAccountHostedArtifactUnavailable = Readonly<{
    kind: 'unavailable';
    code: ActivePluginAccountHostedArtifactUnavailableCode;
}>;

export type ActivePluginAccountHostedArtifactReadResult =
    | Readonly<{
        kind: 'available';
        value: Readonly<{
            link: PluginAvailabilityUiArtifactReadActionOutputV1['link'];
            archive: PluginUiArtifactArchiveOpenedV1;
        }>;
    }>
    | ActivePluginAccountHostedArtifactUnavailable;

export type ActivePluginAccountHostedArtifactReader = Readonly<{
    read: (
        input: ActivePluginAccountHostedArtifactReadInput,
    ) => Promise<ActivePluginAccountHostedArtifactReadResult>;
    /** Reads one exact prospective release slot and returns its canonical link. */
    readTarget: (
        input: ActivePluginAccountHostedArtifactTargetReadInput,
    ) => Promise<ActivePluginAccountHostedArtifactReadResult>;
}>;

export type ActivePluginAccountHostedArtifactReaderDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => AccountHostedArtifactServerSnapshot;
    captureRequestAuthority: (input: Readonly<{
        scope: ServerAccountScope;
        activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
    }>) => Promise<AccountHostedArtifactRequestAuthority>;
    readAccountCurrentness: (input: Readonly<{
        authority: AccountHostedArtifactRequestAuthority;
        signal: AbortSignal;
    }>) => Promise<AccountEncryptionCurrentnessResponse>;
    resolveStoredContentCompatibility: (
        input: HeadersInit,
        params: Readonly<{ serverUrl: string }>,
    ) => AccountStoredContentCompatibilityHeaderResolution;
}>;

export type ActivePluginAccountHostedArtifactPublishInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    release: PluginAvailabilityUiArtifactPublishActionInputV1['release'];
    slot: PluginAvailabilityUiArtifactPublishActionInputV1['slot'];
    hostCompatibility: PluginAvailabilityUiArtifactPublishActionInputV1['hostCompatibility'];
    artifactGraph: unknown;
    files: readonly Readonly<{
        relativePath: string;
        bytes: Uint8Array;
    }>[];
    signal?: AbortSignal;
}>;

export type ActivePluginAccountHostedArtifactPublishResult =
    | Readonly<{
        kind: 'published';
        value: PluginAvailabilityUiArtifactPublishActionOutputV1;
    }>
    | ActivePluginAccountHostedArtifactUnavailable;

export type ActivePluginAccountHostedArtifactPublisher = Readonly<{
    publish: (
        input: ActivePluginAccountHostedArtifactPublishInput,
    ) => Promise<ActivePluginAccountHostedArtifactPublishResult>;
}>;

export type ActivePluginAccountHostedArtifactPublisherDependencies =
    ActivePluginAccountHostedArtifactReaderDependencies;

function unavailable(
    code: ActivePluginAccountHostedArtifactUnavailableCode,
): ActivePluginAccountHostedArtifactUnavailable {
    return Object.freeze({ kind: 'unavailable', code });
}

function sameServerSnapshot(
    left: AccountHostedArtifactServerSnapshot,
    right: AccountHostedArtifactServerSnapshot,
): boolean {
    return left.serverId === right.serverId && left.generation === right.generation;
}

function readCurrentnessCode(input: Readonly<{
    requestedLifetime: ActiveServerAccountScopeLifetime;
    capturedLifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: AccountHostedArtifactServerSnapshot;
    getServerSnapshot: () => AccountHostedArtifactServerSnapshot;
}>): Extract<ActivePluginAccountHostedArtifactReadResult, { kind: 'unavailable' }>['code'] | null {
    if (!input.requestedLifetime.isCurrent() || !input.capturedLifetime.isCurrent()) {
        return 'account_scope_changed';
    }
    return sameServerSnapshot(input.getServerSnapshot(), input.serverSnapshot)
        ? null
        : 'server_generation_changed';
}

function responseMatchesExpected(input: Readonly<{
    response: PluginAvailabilityUiArtifactReadActionOutputV1;
    request: PluginAvailabilityUiArtifactReadActionInputV1;
    expectedArtifactId: string | null;
    expectedArtifactDigest: string;
}>): boolean {
    const { link } = input.response;
    return link.release.pluginId === input.request.release.pluginId
        && link.release.version === input.request.release.version
        && link.contributionId === input.request.contributionId
        && link.tier === input.request.tier
        && link.platform === input.request.platform
        && (input.expectedArtifactId === null || link.artifactId === input.expectedArtifactId)
        && link.artifactDigest === input.expectedArtifactDigest;
}

function archiveMatchesLink(input: Readonly<{
    archive: PluginUiArtifactArchiveOpenedV1;
    link: PluginAvailabilityUiArtifactReadActionOutputV1['link'];
}>): boolean {
    const graph = input.archive.artifactGraph;
    return graph.contributionId === input.link.contributionId
        && graph.tier === input.link.tier
        && (graph.platform ?? 'web') === input.link.platform
        && graph.digest === input.link.artifactDigest;
}

function archiveMatchesPublishSlot(input: Readonly<{
    archive: NonNullable<ReturnType<typeof createPluginUiArtifactArchiveV1>>;
    slot: PluginAvailabilityUiArtifactPublishActionInputV1['slot'];
}>): boolean {
    const graph = input.archive.header.artifactGraph;
    const frameworkCompatibilityMatches = input.slot.tier === 'hostedWeb'
        ? Object.keys(graph.compat).length === 0
        : graph.compat.react === input.slot.compatibility.reactVersion
            && graph.compat.reactNative === input.slot.compatibility.reactNativeVersion
            && graph.compat.expoRuntime === input.slot.compatibility.expoRuntimeVersion
            && graph.compat.hermes === input.slot.compatibility.hermesVersion;
    return graph.contributionId === input.slot.contributionId
        && graph.tier === input.slot.tier
        && (graph.platform ?? 'web') === input.slot.platform
        && graph.digest === input.slot.artifactDigest
        && graph.hostUiApiVersion === input.slot.compatibility.hostUiApiVersion
        && frameworkCompatibilityMatches;
}

function sameHostCompatibility(
    left: PluginAvailabilityUiArtifactPublishActionInputV1['hostCompatibility'],
    right: PluginAvailabilityUiArtifactPublishActionOutputV1['link']['compatibility'],
): boolean {
    return left.hostAppVersion === right.hostAppVersion
        && left.hostUiApiVersion === right.hostUiApiVersion
        && left.reactVersion === right.reactVersion
        && left.reactNativeVersion === right.reactNativeVersion
        && left.expoRuntimeVersion === right.expoRuntimeVersion
        && left.hermesVersion === right.hermesVersion
        && left.platform === right.platform
        && left.channel === right.channel
        && left.nativeCapabilities.length === right.nativeCapabilities.length
        && left.nativeCapabilities.every((capability, index) => (
            capability === right.nativeCapabilities[index]
        ));
}

function publishResponseMatchesExpected(input: Readonly<{
    response: PluginAvailabilityUiArtifactPublishActionOutputV1;
    request: PluginAvailabilityUiArtifactPublishActionInputV1;
}>): boolean {
    const { link } = input.response;
    return link.release.pluginId === input.request.release.pluginId
        && link.release.version === input.request.release.version
        && link.contributionId === input.request.slot.contributionId
        && link.tier === input.request.slot.tier
        && link.platform === input.request.slot.platform
        && (
            input.response.outcome === 'rejoined'
            || link.artifactId === input.request.artifactId
        )
        && link.artifactDigest === input.request.slot.artifactDigest
        && sameHostCompatibility(input.request.hostCompatibility, link.compatibility);
}

async function resolveCurrentE2eeArtifactEnvelopeKeySealer(input: Readonly<{
    authority: AccountHostedArtifactRequestAuthority;
    currentness: AccountEncryptionCurrentnessResponse;
}>): Promise<AccountArtifactEnvelopeKeySealer | null> {
    if (
        input.currentness.mode !== 'e2ee'
        || !input.currentness.contentKeyFingerprint
        || !input.authority.credentials
    ) {
        return null;
    }
    try {
        const credentials = input.authority.credentials;
        const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material,
            ...(isDataKeyAuthCredentials(credentials)
                ? {
                    dataKeyPublicKey: decodeBase64(
                        credentials.encryption.publicKey,
                        'base64',
                    ),
                }
                : {}),
        });
        if (
            convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                snapshot.contentPublicKeyFingerprint,
            ) !== input.currentness.contentKeyFingerprint
        ) {
            return null;
        }
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        return async (dataKey) => await encryption.encryptEncryptionKey(dataKey);
    } catch {
        return null;
    }
}

function defaultDependencies(): ActivePluginAccountHostedArtifactReaderDependencies {
    return {
        captureLifetime: captureActiveServerAccountScopeLifetime,
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return {
                serverId: snapshot.serverId,
                serverUrl: snapshot.serverUrl,
                generation: snapshot.generation,
            };
        },
        captureRequestAuthority: async ({ scope, activeRequest }) => {
            const authority = await captureSessionRequestAuthorityForServerAccountScope({
                scope,
                activeRequest,
            });
            return Object.freeze({
                request: authority.request,
                ...(authority.context.credentials
                    ? { credentials: authority.context.credentials }
                    : {}),
                ...(authority.context.encryption
                    ? {
                        decryptDataEncryptionKey: (value: string) =>
                            authority.context.encryption!.decryptEncryptionKey(value),
                    }
                    : {}),
            });
        },
        readAccountCurrentness: async ({ authority, signal }) => {
            if (!authority.credentials) {
                throw new Error('Account credentials are unavailable for Artifact currentness.');
            }
            return await fetchAccountEncryptionCurrentness(authority.credentials, {
                request: (path, init) => authority.request(path, init),
                signal,
            });
        },
        resolveStoredContentCompatibility: (input, params) =>
            resolveAccountStoredContentCompatibilityHeaders(input, params),
    };
}

/**
 * The only active-Account reader for classified hosted UI Artifact envelopes.
 * It has no generic Artifact list/read dependency and it produces no cache,
 * source-order, or renderer authority.
 */
export function createActivePluginAccountHostedArtifactReader(
    overrides: Partial<ActivePluginAccountHostedArtifactReaderDependencies> = {},
): ActivePluginAccountHostedArtifactReader {
    const dependencies: ActivePluginAccountHostedArtifactReaderDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };

    const readExact = async (
        input: ActivePluginAccountHostedArtifactReadInput | ActivePluginAccountHostedArtifactTargetReadInput,
    ): Promise<ActivePluginAccountHostedArtifactReadResult> => {
        const expectedArtifactId = 'expectedArtifactId' in input
            ? input.expectedArtifactId
            : null;
        if (input.signal?.aborted) return unavailable('operation_cancelled');
        if (!input.accountLifetime.isCurrent()) return unavailable('account_scope_changed');
        const capturedLifetime = dependencies.captureLifetime();
        if (!capturedLifetime) return unavailable('no_active_account_scope');
        if (
            !capturedLifetime.isCurrent()
            || !areServerAccountScopesEqual(capturedLifetime.scope, input.accountLifetime.scope)
        ) {
            return unavailable('account_scope_changed');
        }
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== input.accountLifetime.scope.serverId) {
            return unavailable('server_generation_changed');
        }
        const request = PluginAvailabilityUiArtifactReadActionInputV1Schema.safeParse({
            release: input.release,
            ...input.slot,
            // This explicit, narrow server-owned purpose admits one exact
            // prospective release slot for Data preparation. Ordinary hosted
            // rendering deliberately retains the current-intent fence.
            ...(expectedArtifactId === null ? {
                purpose: 'candidatePreparation' as const,
                expectedArtifactDigest: input.expectedArtifactDigest,
            } : {}),
        });
        if (!request.success) return unavailable('response_identity_mismatch');
        const compatibility = dependencies.resolveStoredContentCompatibility(
            { 'Content-Type': 'application/json' },
            { serverUrl: serverSnapshot.serverUrl },
        );
        if (compatibility.status === 'unavailable') {
            return unavailable('stored_content_compatibility_unavailable');
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        const requestedRetirement = input.accountLifetime.onRetire(abort);
        const capturedRetirement = capturedLifetime === input.accountLifetime
            ? null
            : capturedLifetime.onRetire(abort);
        input.signal?.addEventListener('abort', abort, { once: true });
        const release = () => {
            requestedRetirement.dispose();
            capturedRetirement?.dispose();
            input.signal?.removeEventListener('abort', abort);
        };
        try {
            const authority = await dependencies.captureRequestAuthority({
                scope: input.accountLifetime.scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            const authorityCurrentness = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (authorityCurrentness) return unavailable(authorityCurrentness);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }

            let accountCurrentness: AccountEncryptionCurrentnessResponse;
            try {
                accountCurrentness = await dependencies.readAccountCurrentness({
                    authority,
                    signal: controller.signal,
                });
            } catch {
                return unavailable(controller.signal.aborted
                    ? (input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed')
                    : 'account_currentness_unavailable');
            }
            const currentnessAfterAccountRead = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterAccountRead) return unavailable(currentnessAfterAccountRead);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }
            if (accountCurrentness.mode === 'e2ee' && !authority.decryptDataEncryptionKey) {
                return unavailable('account_encryption_material_unavailable');
            }

            let raw: unknown;
            try {
                const response = await authority.request(
                    PluginAvailabilityActionHttpPathsV1[
                        'account.plugins.availability.uiArtifact.read'
                    ],
                    withAccountStoredContentCompatibilityRequestDeclaration({
                        method: 'POST',
                        headers: compatibility.headers,
                        body: JSON.stringify(request.data),
                        signal: controller.signal,
                    }, compatibility.declaration),
                );
                if (!response.ok) return unavailable('transport_unavailable');
                raw = await response.json().catch(() => null);
            } catch {
                return unavailable(controller.signal.aborted
                    ? (input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed')
                    : 'transport_unavailable');
            }
            const currentnessAfterResponse = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterResponse) return unavailable(currentnessAfterResponse);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }
            const parsed = PluginAvailabilityUiArtifactReadActionOutputV1Schema.safeParse(raw);
            if (!parsed.success) return unavailable('response_invalid');
            if (!responseMatchesExpected({
                response: parsed.data,
                request: request.data,
                expectedArtifactId,
                expectedArtifactDigest: input.expectedArtifactDigest,
            })) {
                return unavailable('response_identity_mismatch');
            }

            const envelope = await openAccountArtifactStoredEnvelope({
                mode: accountCurrentness.mode,
                envelope: {
                    header: parsed.data.artifact.header,
                    body: parsed.data.artifact.body,
                    dataEncryptionKey: parsed.data.artifact.dataEncryptionKey,
                },
                ...(authority.decryptDataEncryptionKey
                    ? { decryptDataEncryptionKey: authority.decryptDataEncryptionKey }
                    : {}),
            });
            const currentnessAfterEnvelope = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterEnvelope) return unavailable(currentnessAfterEnvelope);
            if (!envelope) return unavailable('artifact_envelope_unavailable');
            const body = envelope.body.body === null
                ? null
                : decodePluginUiArtifactArchiveBodyV1(envelope.body.body);
            const archive = body
                ? openPluginUiArtifactArchiveV1({
                    pluginId: request.data.release.pluginId,
                    expectedArtifactDigest: parsed.data.link.artifactDigest,
                    header: envelope.header,
                    body,
                })
                : null;
            if (!archive || !archiveMatchesLink({ archive, link: parsed.data.link })) {
                return unavailable('artifact_archive_invalid');
            }
            return Object.freeze({
                kind: 'available',
                value: Object.freeze({ link: parsed.data.link, archive }),
            });
        } finally {
            release();
        }
    };

    return Object.freeze({
        read: async (input) => await readExact(input),
        readTarget: async (input) => await readExact(input),
    });
}

/**
 * The explicit present-client publication action for one already-admitted UI
 * archive. It never chooses a byte source, uploads automatically, or owns
 * retry/cache state; it only constructs the incumbent Artifact envelope and
 * uses Availability's atomic qualified publication route.
 */
export function createActivePluginAccountHostedArtifactPublisher(
    overrides: Partial<ActivePluginAccountHostedArtifactPublisherDependencies> = {},
): ActivePluginAccountHostedArtifactPublisher {
    const dependencies: ActivePluginAccountHostedArtifactPublisherDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };

    const publish = async (
        input: ActivePluginAccountHostedArtifactPublishInput,
    ): Promise<ActivePluginAccountHostedArtifactPublishResult> => {
        if (input.signal?.aborted) return unavailable('operation_cancelled');
        if (!input.accountLifetime.isCurrent()) return unavailable('account_scope_changed');
        const capturedLifetime = dependencies.captureLifetime();
        if (!capturedLifetime) return unavailable('no_active_account_scope');
        if (
            !capturedLifetime.isCurrent()
            || !areServerAccountScopesEqual(capturedLifetime.scope, input.accountLifetime.scope)
        ) {
            return unavailable('account_scope_changed');
        }
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== input.accountLifetime.scope.serverId) {
            return unavailable('server_generation_changed');
        }

        let archive: NonNullable<ReturnType<typeof createPluginUiArtifactArchiveV1>>;
        try {
            const created = createPluginUiArtifactArchiveV1({
                pluginId: input.release.pluginId,
                artifactGraph: input.artifactGraph,
                files: input.files,
            });
            if (
                !created
                || !archiveMatchesPublishSlot({ archive: created, slot: input.slot })
                || !isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
                    input.slot,
                    input.hostCompatibility,
                )
            ) {
                return unavailable('source_archive_invalid');
            }
            archive = created;
        } catch {
            return unavailable('source_archive_invalid');
        }

        const compatibility = dependencies.resolveStoredContentCompatibility(
            { 'Content-Type': 'application/json' },
            { serverUrl: serverSnapshot.serverUrl },
        );
        if (compatibility.status === 'unavailable') {
            return unavailable('stored_content_compatibility_unavailable');
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        const requestedRetirement = input.accountLifetime.onRetire(abort);
        const capturedRetirement = capturedLifetime === input.accountLifetime
            ? null
            : capturedLifetime.onRetire(abort);
        input.signal?.addEventListener('abort', abort, { once: true });
        const release = () => {
            requestedRetirement.dispose();
            capturedRetirement?.dispose();
            input.signal?.removeEventListener('abort', abort);
        };
        try {
            const authority = await dependencies.captureRequestAuthority({
                scope: input.accountLifetime.scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            const authorityCurrentness = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (authorityCurrentness) return unavailable(authorityCurrentness);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }

            let accountCurrentness: AccountEncryptionCurrentnessResponse;
            try {
                accountCurrentness = await dependencies.readAccountCurrentness({
                    authority,
                    signal: controller.signal,
                });
            } catch {
                return unavailable(controller.signal.aborted
                    ? (input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed')
                    : 'account_currentness_unavailable');
            }
            const currentnessAfterAccountRead = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterAccountRead) return unavailable(currentnessAfterAccountRead);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }

            const encryptDataEncryptionKey = accountCurrentness.mode === 'e2ee'
                ? await resolveCurrentE2eeArtifactEnvelopeKeySealer({
                    authority,
                    currentness: accountCurrentness,
                })
                : undefined;
            const currentnessAfterKeyResolution = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterKeyResolution) return unavailable(currentnessAfterKeyResolution);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }
            if (accountCurrentness.mode === 'e2ee' && !encryptDataEncryptionKey) {
                return unavailable('account_encryption_material_unavailable');
            }

            const envelope = await createAccountArtifactStoredEnvelope({
                mode: accountCurrentness.mode,
                header: archive.header,
                body: { body: encodePluginUiArtifactArchiveBodyV1(archive.body) },
                ...(encryptDataEncryptionKey ? { encryptDataEncryptionKey } : {}),
            });
            const currentnessAfterEnvelope = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterEnvelope) return unavailable(currentnessAfterEnvelope);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }
            if (!envelope) return unavailable('artifact_envelope_unavailable');

            const request = PluginAvailabilityUiArtifactPublishActionInputV1Schema.safeParse({
                release: input.release,
                slot: input.slot,
                hostCompatibility: input.hostCompatibility,
                artifactId: randomUUID(),
                artifact: envelope,
            });
            if (!request.success) return unavailable('source_archive_invalid');

            let raw: unknown;
            try {
                const response = await authority.request(
                    PluginAvailabilityActionHttpPathsV1[
                        'account.plugins.availability.uiArtifact.publish'
                    ],
                    withAccountStoredContentCompatibilityRequestDeclaration({
                        method: 'POST',
                        headers: compatibility.headers,
                        body: JSON.stringify(request.data),
                        signal: controller.signal,
                    }, compatibility.declaration),
                );
                if (!response.ok) return unavailable('transport_unavailable');
                raw = await response.json().catch(() => null);
            } catch {
                return unavailable(controller.signal.aborted
                    ? (input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed')
                    : 'transport_unavailable');
            }
            const currentnessAfterResponse = readCurrentnessCode({
                requestedLifetime: input.accountLifetime,
                capturedLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (currentnessAfterResponse) return unavailable(currentnessAfterResponse);
            if (controller.signal.aborted) {
                return unavailable(input.signal?.aborted ? 'operation_cancelled' : 'account_scope_changed');
            }
            const parsed = PluginAvailabilityUiArtifactPublishActionOutputV1Schema.safeParse(raw);
            if (!parsed.success) return unavailable('response_invalid');
            if (!publishResponseMatchesExpected({ response: parsed.data, request: request.data })) {
                return unavailable('response_identity_mismatch');
            }
            return Object.freeze({ kind: 'published', value: parsed.data });
        } finally {
            release();
        }
    };

    return Object.freeze({ publish });
}

const installedReader = createActivePluginAccountHostedArtifactReader();
const installedPublisher = createActivePluginAccountHostedArtifactPublisher();

/** Explicit action entry point; callers must supply a user-admitted archive. */
export async function publishActivePluginAccountHostedArtifact(
    input: ActivePluginAccountHostedArtifactPublishInput,
): Promise<ActivePluginAccountHostedArtifactPublishResult> {
    return await installedPublisher.publish(input);
}

/**
 * Adapts only one current qualified Account Artifact into Artifact's existing
 * source-candidate contract. It owns neither source precedence nor cache
 * custody; its one in-flight archive read merely prevents repeated transport
 * while the lease asks for the declared files.
 */
export function createActivePluginAccountHostedArtifactSourceCandidate(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    reader?: ActivePluginAccountHostedArtifactReader;
}>): PluginArtifactSourceCandidate & Readonly<{ kind: 'accountHosted' }> {
    const reader = input.reader ?? installedReader;
    let pendingKey: string | null = null;
    let pending: Promise<ActivePluginAccountHostedArtifactReadResult> | null = null;
    return Object.freeze({
        kind: 'accountHosted' as const,
        readFile: async ({ artifact, relativePath, accountHostedArtifactId }) => {
            if (!input.accountLifetime.isCurrent() || !accountHostedArtifactId) return null;
            const key = [
                artifact.pluginId,
                artifact.releaseVersion,
                artifact.contributionId,
                artifact.tier,
                artifact.platform,
                accountHostedArtifactId,
                artifact.digest,
            ].join('\u0000');
            if (pendingKey !== key || !pending) {
                pendingKey = key;
                pending = reader.read({
                    accountLifetime: input.accountLifetime,
                    release: {
                        pluginId: artifact.pluginId,
                        version: artifact.releaseVersion,
                    },
                    slot: {
                        contributionId: artifact.contributionId,
                        tier: artifact.tier,
                        platform: artifact.platform,
                    },
                    expectedArtifactId: accountHostedArtifactId,
                    expectedArtifactDigest: artifact.digest,
                });
            }
            const result = await pending;
            if (result.kind !== 'available' || !input.accountLifetime.isCurrent()) {
                if (pendingKey === key) {
                    pendingKey = null;
                    pending = null;
                }
                return null;
            }
            const bytes = result.value.archive.files.get(relativePath);
            return bytes ? new Uint8Array(bytes) : null;
        },
    });
}

/**
 * Adapts one prospective release slot through Availability's qualified read.
 * The server-selected link remains inside this boundary: consumers receive
 * only declared bytes after the exact target digest has been verified.
 */
export function createActivePluginAccountHostedArtifactTargetSourceCandidate(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    reader?: ActivePluginAccountHostedArtifactReader;
}>): PluginArtifactSourceCandidate & Readonly<{ kind: 'accountHosted' }> {
    const reader = input.reader ?? installedReader;
    let pendingKey: string | null = null;
    let pending: Promise<ActivePluginAccountHostedArtifactReadResult> | null = null;
    return Object.freeze({
        kind: 'accountHosted' as const,
        readFile: async ({ artifact, relativePath }) => {
            if (!input.accountLifetime.isCurrent()) return null;
            const key = [
                artifact.pluginId,
                artifact.releaseVersion,
                artifact.contributionId,
                artifact.tier,
                artifact.platform,
                artifact.digest,
                String(artifact.availabilityCursor),
            ].join('\u0000');
            if (pendingKey !== key || !pending) {
                pendingKey = key;
                pending = reader.readTarget({
                    accountLifetime: input.accountLifetime,
                    release: {
                        pluginId: artifact.pluginId,
                        version: artifact.releaseVersion,
                    },
                    slot: {
                        contributionId: artifact.contributionId,
                        tier: artifact.tier,
                        platform: artifact.platform,
                    },
                    expectedArtifactDigest: artifact.digest,
                });
            }
            const result = await pending;
            if (result.kind !== 'available' || !input.accountLifetime.isCurrent()) {
                if (pendingKey === key) {
                    pendingKey = null;
                    pending = null;
                }
                return null;
            }
            const bytes = result.value.archive.files.get(relativePath);
            return bytes ? new Uint8Array(bytes) : null;
        },
    });
}
