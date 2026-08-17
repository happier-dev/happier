import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { apiSocket } from '@/sync/api/session/apiSocket';
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
    type AccountArtifactEnvelopeKeyOpener,
} from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type {
    PluginProtectedAccountPackageAssetSource,
    PluginSelectedPackageAssetIdentity,
} from '@/sync/domains/plugins/availability/packageAssetLease';
import {
    resolveAccountStoredContentCompatibilityHeaders,
    withAccountStoredContentCompatibilityRequestDeclaration,
    type AccountStoredContentCompatibilityHeaderResolution,
} from '@/sync/http/accountStoredContentCompatibility';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import {
    decodePackageAssetArchiveBodyV1,
    openPackageAssetArchiveV1,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityPackageAssetReadActionInputV1Schema,
    PluginAvailabilityPackageAssetReadActionOutputV1Schema,
    type PackageAssetArchiveOpenedV1,
} from '@happier-dev/protocol/plugins/availability';

type PackageAssetServerSnapshot = Readonly<{
    serverId: string | null;
    serverUrl: string;
    generation: number;
}>;

type PackageAssetRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    credentials?: AuthCredentials;
    decryptDataEncryptionKey?: AccountArtifactEnvelopeKeyOpener;
}>;

export type ActivePluginAccountPackageAssetReaderDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => PackageAssetServerSnapshot;
    captureRequestAuthority: (input: Readonly<{
        scope: ServerAccountScope;
        activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
    }>) => Promise<PackageAssetRequestAuthority>;
    readAccountCurrentness: (input: Readonly<{
        authority: PackageAssetRequestAuthority;
        signal: AbortSignal;
    }>) => Promise<AccountEncryptionCurrentnessResponse>;
    resolveStoredContentCompatibility: (
        input: HeadersInit,
        params: Readonly<{ serverUrl: string }>,
    ) => AccountStoredContentCompatibilityHeaderResolution;
}>;

function sameServerSnapshot(left: PackageAssetServerSnapshot, right: PackageAssetServerSnapshot): boolean {
    return left.serverId === right.serverId && left.generation === right.generation;
}

function isCurrent(input: Readonly<{
    requestedLifetime: ActiveServerAccountScopeLifetime;
    capturedLifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: PackageAssetServerSnapshot;
    getServerSnapshot: () => PackageAssetServerSnapshot;
}>): boolean {
    return input.requestedLifetime.isCurrent()
        && input.capturedLifetime.isCurrent()
        && sameServerSnapshot(input.serverSnapshot, input.getServerSnapshot());
}

function defaultDependencies(): ActivePluginAccountPackageAssetReaderDependencies {
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
            const authority = await captureSessionRequestAuthorityForServerAccountScope({ scope, activeRequest });
            return Object.freeze({
                request: authority.request,
                ...(authority.context.credentials ? { credentials: authority.context.credentials } : {}),
                ...(authority.context.encryption ? {
                    decryptDataEncryptionKey: (value: string) =>
                        authority.context.encryption!.decryptEncryptionKey(value),
                } : {}),
            });
        },
        readAccountCurrentness: async ({ authority, signal }) => {
            if (!authority.credentials) throw new Error('Account credentials are unavailable.');
            return await fetchAccountEncryptionCurrentness(authority.credentials, {
                request: (path, init) => authority.request(path, init),
                signal,
            });
        },
        resolveStoredContentCompatibility: (input, params) =>
            resolveAccountStoredContentCompatibilityHeaders(input, params),
    };
}

function responseMatchesIdentity(input: Readonly<{
    response: unknown;
    identity: PluginSelectedPackageAssetIdentity;
}>): boolean {
    const parsed = PluginAvailabilityPackageAssetReadActionOutputV1Schema.safeParse(input.response);
    if (!parsed.success) return false;
    const { link } = parsed.data;
    return link.release.pluginId === input.identity.pluginId
        && link.release.version === input.identity.releaseVersion
        && link.descriptor.archiveDigestSha256 === input.identity.descriptor.archiveDigestSha256
        && JSON.stringify(link.descriptor.resources) === JSON.stringify(input.identity.descriptor.resources);
}

/**
 * The one UI reader for protected Account Package Asset archives. It selects
 * nothing: Availability supplies the release descriptor and the server owns
 * the qualified Artifact link. Plain/E2EE envelope opening stays at the
 * generic Artifact owner, and every await is bracketed by Account/server
 * currentness checks.
 */
export function createActivePluginAccountPackageAssetSource(
    overrides: Partial<ActivePluginAccountPackageAssetReaderDependencies> = {},
): PluginProtectedAccountPackageAssetSource {
    const dependencies: ActivePluginAccountPackageAssetReaderDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    const readArchive = async (
        identity: PluginSelectedPackageAssetIdentity,
    ): Promise<PackageAssetArchiveOpenedV1 | null> => {
        const requestedLifetime = dependencies.captureLifetime();
        if (!requestedLifetime || !requestedLifetime.isCurrent()) return null;
        const capturedLifetime = dependencies.captureLifetime();
        if (
            !capturedLifetime
            || !capturedLifetime.isCurrent()
            || !areServerAccountScopesEqual(capturedLifetime.scope, requestedLifetime.scope)
        ) return null;
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== requestedLifetime.scope.serverId) return null;
        const request = PluginAvailabilityPackageAssetReadActionInputV1Schema.safeParse({
            release: { pluginId: identity.pluginId, version: identity.releaseVersion },
        });
        if (!request.success) return null;
        const compatibility = dependencies.resolveStoredContentCompatibility(
            { 'Content-Type': 'application/json' },
            { serverUrl: serverSnapshot.serverUrl },
        );
        if (compatibility.status === 'unavailable') return null;

        const controller = new AbortController();
        const abort = () => controller.abort();
        const requestedRetirement = requestedLifetime.onRetire(abort);
        const capturedRetirement = capturedLifetime === requestedLifetime
            ? null
            : capturedLifetime.onRetire(abort);
        try {
            const authority = await dependencies.captureRequestAuthority({
                scope: requestedLifetime.scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            if (!isCurrent({ requestedLifetime, capturedLifetime, serverSnapshot, getServerSnapshot: dependencies.getServerSnapshot }) || controller.signal.aborted) return null;
            const currentness = await dependencies.readAccountCurrentness({ authority, signal: controller.signal });
            if (!isCurrent({ requestedLifetime, capturedLifetime, serverSnapshot, getServerSnapshot: dependencies.getServerSnapshot }) || controller.signal.aborted) return null;
            if (currentness.mode === 'e2ee' && !authority.decryptDataEncryptionKey) return null;
            const response = await authority.request(
                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.read'],
                withAccountStoredContentCompatibilityRequestDeclaration({
                    method: 'POST',
                    headers: compatibility.headers,
                    body: JSON.stringify(request.data),
                    signal: controller.signal,
                }, compatibility.declaration),
            );
            if (!response.ok) return null;
            const raw = await response.json().catch(() => null);
            if (!isCurrent({ requestedLifetime, capturedLifetime, serverSnapshot, getServerSnapshot: dependencies.getServerSnapshot }) || controller.signal.aborted) return null;
            if (!responseMatchesIdentity({ response: raw, identity })) return null;
            const parsed = PluginAvailabilityPackageAssetReadActionOutputV1Schema.parse(raw);
            const envelope = await openAccountArtifactStoredEnvelope({
                mode: currentness.mode,
                envelope: {
                    header: parsed.artifact.header,
                    body: parsed.artifact.body,
                    dataEncryptionKey: parsed.artifact.dataEncryptionKey,
                },
                ...(authority.decryptDataEncryptionKey ? {
                    decryptDataEncryptionKey: authority.decryptDataEncryptionKey,
                } : {}),
            });
            if (!isCurrent({ requestedLifetime, capturedLifetime, serverSnapshot, getServerSnapshot: dependencies.getServerSnapshot }) || !envelope) return null;
            const body = envelope.body.body === null
                ? null
                : decodePackageAssetArchiveBodyV1(envelope.body.body);
            return body ? openPackageAssetArchiveV1({
                expectedDescriptor: identity.descriptor,
                header: envelope.header,
                body,
            }) : null;
        } catch {
            return null;
        } finally {
            requestedRetirement.dispose();
            capturedRetirement?.dispose();
        }
    };
    return Object.freeze({ readArchive });
}

const installedPackageAssetSource = createActivePluginAccountPackageAssetSource();

export function getActivePluginAccountPackageAssetSource(): PluginProtectedAccountPackageAssetSource {
    return installedPackageAssetSource;
}
