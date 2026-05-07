import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { createGeneratedAvatarCacheKey } from '@/components/ui/avatar/generation/cache/key';
import {
    readAvatarRasterFromMemory,
    writeAvatarRasterToMemory,
} from '@/components/ui/avatar/generation/cache/memory';
import {
    readAvatarRasterFromStore,
    writeAvatarRasterToStore,
} from '@/components/ui/avatar/generation/cache/store';

import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';
import { derivePhotoGradientAvatar } from './derivePhotoGradientAvatar';
import {
    renderPhotoGradientRasterDataUri,
    type PhotoGradientRasterEnvironment,
} from './renderPhotoGradientRaster';

const RENDER_SIZE = 128;

type Params = Readonly<{
    id: string;
    styleId?: AvatarStyleId;
    monochrome: boolean;
    theme: MeshGradientThemeInput;
}>;

function themeSignature(theme: MeshGradientThemeInput): string {
    return [
        theme.surface,
        theme.surfaceHigh,
        theme.surfaceHighest,
        theme.textSecondary,
        ...theme.accentColors,
    ].join('|');
}

function cacheKey(params: Params): string {
    return createGeneratedAvatarCacheKey([
        'photoGradient-raster',
        params.id,
        params.styleId ?? 'photoGradient',
        params.monochrome ? 'monochrome' : 'color',
        themeSignature(params.theme),
    ]);
}

export function getCachedPhotoGradientAvatarDataUri(params: Params): string | null {
    const key = cacheKey(params);
    const memory = readAvatarRasterFromMemory(key);
    if (memory) return memory;

    const stored = readAvatarRasterFromStore(key);
    if (stored) {
        writeAvatarRasterToMemory(key, stored);
        return stored;
    }

    return null;
}

export async function generateAndCachePhotoGradientAvatarDataUri(
    params: Params,
    environment?: PhotoGradientRasterEnvironment,
): Promise<string | null> {
    const existing = getCachedPhotoGradientAvatarDataUri(params);
    if (existing) return existing;

    const model = derivePhotoGradientAvatar({
        id: params.id,
        size: RENDER_SIZE,
        monochrome: params.monochrome,
        styleId: params.styleId,
        theme: params.theme,
    });
    const dataUri = renderPhotoGradientRasterDataUri(model, environment);
    if (!dataUri) return null;

    const key = cacheKey(params);
    writeAvatarRasterToMemory(key, dataUri);
    writeAvatarRasterToStore(key, dataUri);
    return dataUri;
}
