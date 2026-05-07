import * as React from 'react';
import type { ImageProps } from 'expo-image';
import {
    DaemonPetReadPreviewAssetResponseV1Schema,
    PET_DAEMON_RPC_METHODS,
    type DaemonPetReadPreviewAssetRequestV1,
    type PetAssetMediaTypeV1,
} from '@happier-dev/protocol';

import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { encodeBase64 } from '@/encryption/base64';
import { serverFetch } from '@/sync/http/client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

const daemonPreviewAssetCache = new Map<string, ImageProps['source']>();

type PetSpritesheetSourceStatus = 'loading' | 'ready' | 'error';

export type PetSpritesheetSourceResult = Readonly<{
    source: ImageProps['source'] | null;
    status: PetSpritesheetSourceStatus;
}>;

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

async function readAccountPetSpritesheetSource(accountPetId: string): Promise<ImageProps['source'] | null> {
    const response = await serverFetch(
        `/v1/account/pets/${accountPetId}/spritesheet`,
        undefined,
        { retry: 'none' },
    );
    if (!response.ok) return null;

    const mediaType = readContentType(response.headers);
    if (!mediaType) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    return toDataUri(mediaType, encodeBase64(bytes, 'base64'));
}

async function readDaemonPetPreviewSource(source: Extract<SelectedPetPackageSource, { kind: 'detectedCodexHome' | 'happierManagedLocal' }>): Promise<ImageProps['source'] | null> {
    const target = source.daemonTarget;
    if (!target?.machineId || !target.serverId) return null;

    const cachedKey = source.digest ? `${source.sourceKey}:${source.digest}` : null;
    if (cachedKey) {
        const cached = daemonPreviewAssetCache.get(cachedKey);
        if (cached) return cached;
    }

    const payload: DaemonPetReadPreviewAssetRequestV1 = { sourceKey: source.sourceKey };
    const raw = await machineRpcWithServerScope<unknown, DaemonPetReadPreviewAssetRequestV1>({
        machineId: target.machineId,
        serverId: target.serverId,
        method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
        payload,
    });
    const parsed = DaemonPetReadPreviewAssetResponseV1Schema.parse(raw);
    if ('ok' in parsed) return null;
    if (!isAllowedPetAssetMediaType(parsed.mediaType)) return null;

    const result = toDataUri(parsed.mediaType, parsed.dataBase64);
    daemonPreviewAssetCache.set(`${parsed.sourceKey}:${parsed.digest}`, result);
    return result;
}

export function usePetSpritesheetSourceResult(
    source: SelectedPetPackageSource | null,
    fallbackPetId = 'blink',
    options: Readonly<{
        fallbackWhileLoading?: boolean;
        fallbackOnError?: boolean;
    }> = {},
): PetSpritesheetSourceResult {
    const fallbackWhileLoading = options.fallbackWhileLoading !== false;
    const fallbackOnError = options.fallbackOnError !== false;
    const fallbackSource = React.useMemo(
        () => resolveBuiltInPetPackage(fallbackPetId).spritesheetSource,
        [fallbackPetId],
    );
    const [result, setResult] = React.useState<PetSpritesheetSourceResult>(() => ({
        source: source && !fallbackWhileLoading ? null : fallbackSource,
        status: source ? 'loading' : 'ready',
    }));

    React.useEffect(() => {
        let cancelled = false;
        setResult({
            source: source && !fallbackWhileLoading ? null : fallbackSource,
            status: source ? 'loading' : 'ready',
        });

        const apply = async () => {
            if (!source) return;
            try {
                if (source.kind === 'builtIn') {
                    const builtIn = resolveBuiltInPetPackage(source.petId).spritesheetSource;
                    if (!cancelled) setResult({ source: builtIn, status: 'ready' });
                    return;
                }
                if (source.kind === 'accountPet') {
                    const accountSource = await readAccountPetSpritesheetSource(source.accountPetId);
                    if (!cancelled) {
                        setResult({
                            source: accountSource ?? (fallbackOnError ? fallbackSource : null),
                            status: accountSource ? 'ready' : 'error',
                        });
                    }
                    return;
                }

                const localSource = await readDaemonPetPreviewSource(source);
                if (!cancelled) {
                    setResult({
                        source: localSource ?? (fallbackOnError ? fallbackSource : null),
                        status: localSource ? 'ready' : 'error',
                    });
                }
            } catch {
                if (!cancelled) {
                    setResult({
                        source: fallbackOnError ? fallbackSource : null,
                        status: 'error',
                    });
                }
            }
        };

        void apply();
        return () => {
            cancelled = true;
        };
    }, [fallbackOnError, fallbackSource, fallbackWhileLoading, source]);

    return result;
}

export function usePetSpritesheetSource(
    source: SelectedPetPackageSource | null,
    fallbackPetId = 'blink',
): ImageProps['source'] {
    const result = usePetSpritesheetSourceResult(source, fallbackPetId);
    return result.source ?? resolveBuiltInPetPackage(fallbackPetId).spritesheetSource;
}
