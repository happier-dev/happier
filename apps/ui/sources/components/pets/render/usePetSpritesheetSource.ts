import * as React from 'react';
import type { ImageProps } from 'expo-image';
import { DaemonPetReadPreviewAssetResponseV1Schema, PET_DAEMON_RPC_METHODS, type DaemonPetReadPreviewAssetRequestV1 } from '@happier-dev/protocol/pets/daemonRpc';
import type { PetAssetMediaTypeV1 } from '@happier-dev/protocol/pets/accountLibrary';
import type { PetPackageSourceV1 } from '@happier-dev/protocol/pets/source';

import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { LocalPetPreviewAsset } from '@/sync/domains/pets/localPetSourceTypes';
import { resolveAccountPetReadAdmission } from '@/sync/domains/pets/resolveAccountPetReadAdmission';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { parseToken } from '@/utils/auth/parseToken';

const daemonPreviewAssetCache = new Map<string, ImageProps['source']>();
const spritesheetReads = createScopedResolutionSingleFlight<ImageProps['source'] | null>();

type PetSpritesheetSourceOptions = Readonly<{
    fallbackWhileLoading?: boolean;
    fallbackOnError?: boolean;
    enabled?: boolean;
}>;

type PetSpritesheetSourceStatus = 'loading' | 'ready' | 'error';

export type PetSpritesheetSourceResult = Readonly<{
    source: ImageProps['source'] | null;
    status: PetSpritesheetSourceStatus;
    /** The delivered image's atlas, including a built-in fallback during loading or failure. */
    spriteVersionNumber: 1 | 2;
}>;

function spritesheetSourceKey(source: SelectedPetPackageSource): string {
    return source.kind === 'builtIn'
        ? JSON.stringify([source.kind, source.petId])
        : JSON.stringify([source.kind, source.sourceKey, source.digest, source.kind === 'accountPet'
            ? source.accountPetId : [source.daemonTarget?.serverId, source.daemonTarget?.machineId]]);
}

function isAllowedPetAssetMediaType(value: string | null | undefined): value is PetAssetMediaTypeV1 {
    const mediaType = String(value ?? '').split(';')[0]?.trim().toLowerCase();
    return mediaType === 'image/png' || mediaType === 'image/webp';
}

function toDataUri(mediaType: PetAssetMediaTypeV1, dataBase64: string): string {
    return `data:${mediaType};base64,${dataBase64}`;
}

function readContentType(headers: Headers): PetAssetMediaTypeV1 | null {
    const mediaType = String(headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
    return isAllowedPetAssetMediaType(mediaType) ? mediaType : null;
}

async function readAccountPetSpritesheetSource(accountPetId: string, credentials: AuthCredentials, request: ServerFetch, signal: AbortSignal): Promise<ImageProps['source'] | null> {
    const admission = await resolveAccountPetReadAdmission(credentials, {
        request: (path, init, options) => request(path, { ...init, signal }, options),
    });
    if (admission.status === 'unavailable' || signal.aborted) return null;

    const response = await request(
        `/v1/account/pets/${accountPetId}/spritesheet`,
        {
            signal,
            headers: {
                Authorization: `Bearer ${credentials.token}`,
            },
        },
        { includeAuth: false, retry: 'none' },
    );
    if (!response.ok) return null;

    const mediaType = readContentType(response.headers);
    if (!mediaType) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    return toDataUri(mediaType, encodeBase64(bytes, 'base64'));
}

async function readDaemonPetPreviewSource(source: Extract<SelectedPetPackageSource, { kind: 'detectedCodexHome' | 'happierManagedLocal' }>, credentials: AuthCredentials, cacheScope: string, signal: AbortSignal): Promise<ImageProps['source'] | null> {
    const target = source.daemonTarget;
    if (!target?.machineId || !target.serverId) return null;

    const cachedKey = source.digest ? JSON.stringify([cacheScope, source.sourceKey, source.digest]) : null;
    if (cachedKey) {
        const cached = daemonPreviewAssetCache.get(cachedKey);
        if (cached) return cached;
    }

    const payload: DaemonPetReadPreviewAssetRequestV1 = { sourceKey: source.sourceKey };
    const raw = await machineRpcWithServerScope<unknown, DaemonPetReadPreviewAssetRequestV1>({
        machineId: target.machineId,
        serverId: target.serverId,
        accountId: parseToken(credentials.token),
        method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
        payload,
        signal,
    });
    if (signal.aborted) return null;
    const parsed = DaemonPetReadPreviewAssetResponseV1Schema.parse(raw);
    if ('ok' in parsed) return null;
    if (!isAllowedPetAssetMediaType(parsed.mediaType)) return null;

    const result = toDataUri(parsed.mediaType, parsed.dataBase64);
    daemonPreviewAssetCache.set(JSON.stringify([cacheScope, parsed.sourceKey, parsed.digest]), result);
    return result;
}

async function readSharedPetSpritesheetSource(source: Exclude<SelectedPetPackageSource, { kind: 'builtIn' }>, signal: AbortSignal): Promise<ImageProps['source'] | null> {
    const activeServer = getActiveServerSnapshot();
    const server = source.kind === 'accountPet' ? activeServer : source.daemonTarget
        ? getServerProfileById(source.daemonTarget.serverId) : null;
    if (!server) return null;
    const serverId = 'serverId' in server ? server.serverId : server.id;
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, { serverId });
    if (!credentials || signal.aborted) return null;
    const credentialKey = resolveAuthCredentialsScopeKey(credentials);
    const machineId = source.kind === 'accountPet' ? null : source.daemonTarget?.machineId;
    const scope = JSON.stringify([serverId, credentialKey, machineId]);
    const key = spritesheetSourceKey(source);
    return spritesheetReads.run(key, sharedSignal => source.kind === 'accountPet'
        ? readAccountPetSpritesheetSource(source.accountPetId, credentials, createServerFetchForActiveServer(activeServer, { credentials }), sharedSignal)
        : readDaemonPetPreviewSource(source, credentials, scope, sharedSignal), {
        scope: source.kind === 'accountPet' ? [scope, String(activeServer.generation)] : scope,
        signal,
    });
}

export function usePetSpritesheetSourceResult(
    source: SelectedPetPackageSource | null,
    fallbackPetId = 'blink',
    options: PetSpritesheetSourceOptions = {},
): PetSpritesheetSourceResult {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const sourceKey = !source || options.enabled === false ? null : spritesheetSourceKey(source);
    // Package lookup rebuilds equal descriptors; only asset identity renews demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const selectedSource = React.useMemo(() => sourceKey === null ? null : source, [sourceKey]);
    const fallbackWhileLoading = options.fallbackWhileLoading !== false;
    const fallbackOnError = options.fallbackOnError !== false;
    const fallbackPackage = React.useMemo(
        () => resolveBuiltInPetPackage(fallbackPetId),
        [fallbackPetId],
    );
    const fallbackSource = fallbackPackage.spritesheetSource;
    const fallbackSpriteVersionNumber = fallbackPackage.manifest.spriteVersionNumber ?? 1;
    const [result, setResult] = React.useState<PetSpritesheetSourceResult>(() => ({
        source: selectedSource && !fallbackWhileLoading ? null : fallbackSource,
        status: selectedSource ? 'loading' : 'ready',
        spriteVersionNumber: fallbackSpriteVersionNumber,
    }));

    React.useEffect(() => {
        const controller = new AbortController();
        const source = selectedSource;
        setResult({
            source: source && !fallbackWhileLoading ? null : fallbackSource,
            status: source ? 'loading' : 'ready',
            spriteVersionNumber: fallbackSpriteVersionNumber,
        });

        const apply = async () => {
            if (!source) return;
            try {
                if (source.kind === 'builtIn') {
                    const builtIn = resolveBuiltInPetPackage(source.petId);
                    if (!controller.signal.aborted) setResult({ source: builtIn.spritesheetSource, status: 'ready',
                        spriteVersionNumber: builtIn.manifest.spriteVersionNumber ?? 1 });
                    return;
                }
                const localSource = await readSharedPetSpritesheetSource(source, controller.signal);
                if (!controller.signal.aborted) {
                    setResult({
                        source: localSource ?? (fallbackOnError ? fallbackSource : null),
                        status: localSource ? 'ready' : 'error',
                        spriteVersionNumber: localSource ? source.spriteVersionNumber ?? 1 : fallbackSpriteVersionNumber,
                    });
                }
            } catch {
                if (!controller.signal.aborted) {
                    setResult({
                        source: fallbackOnError ? fallbackSource : null,
                        status: 'error',
                        spriteVersionNumber: fallbackSpriteVersionNumber,
                    });
                }
            }
        };

        void apply();
        return () => {
            controller.abort();
        };
    }, [activeLifetime, fallbackOnError, fallbackSource, fallbackSpriteVersionNumber, fallbackWhileLoading, selectedSource]);

    return result;
}

export function usePetSpritesheetSource(
    source: SelectedPetPackageSource | PetPackageSourceV1 | null | undefined,
    fallbackPetIdOrPreviewAsset: string | LocalPetPreviewAsset | null = 'blink',
    options: PetSpritesheetSourceOptions = {},
): ImageProps['source'] {
    const fallbackPetId = typeof fallbackPetIdOrPreviewAsset === 'string' ? fallbackPetIdOrPreviewAsset : 'blink';
    const selectedSource = React.useMemo<SelectedPetPackageSource | null>(() => {
        if (!source) return null;
        if (source.kind === 'builtIn' || source.kind === 'accountPet') return source;
        if ('daemonTarget' in source && source.daemonTarget) return source;
        if (fallbackPetIdOrPreviewAsset && typeof fallbackPetIdOrPreviewAsset === 'object') {
            return {
                kind: source.kind,
                sourceKey: source.sourceKey,
                mediaType: fallbackPetIdOrPreviewAsset.mediaType,
                spriteVersionNumber: fallbackPetIdOrPreviewAsset.spriteVersionNumber,
                digest: fallbackPetIdOrPreviewAsset.digest ?? undefined,
                daemonTarget: fallbackPetIdOrPreviewAsset.target,
            };
        }
        return {
            kind: source.kind,
            sourceKey: source.sourceKey,
        };
    }, [fallbackPetIdOrPreviewAsset, source]);
    const result = usePetSpritesheetSourceResult(selectedSource, fallbackPetId, options);
    return result.source ?? resolveBuiltInPetPackage(fallbackPetId).spritesheetSource;
}
