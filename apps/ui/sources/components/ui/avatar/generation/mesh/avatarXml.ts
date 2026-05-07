import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { createGeneratedAvatarCacheKey } from '@/components/ui/avatar/generation/cache/key';
import { readAvatarXmlFromMemory, writeAvatarXmlToMemory } from '@/components/ui/avatar/generation/cache/memory';
import { readAvatarXmlFromStore, writeAvatarXmlToStore } from '@/components/ui/avatar/generation/cache/store';
import { getMeshGradientVariantForAvatarStyle } from '@/components/ui/avatar/avatarStyleOptions';
import { deriveMeshGradientAvatar } from '@/components/ui/avatar/meshGradient/deriveMeshGradientAvatar';
import type { MeshGradientThemeInput } from '@/components/ui/avatar/meshGradient/meshGradientTypes';

import { renderMeshGradientSvg } from './render';

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

export function getCachedMeshGradientAvatarXml(params: Params): string {
    const selectedVariant = params.styleId ? getMeshGradientVariantForAvatarStyle(params.styleId) : 'auto';
    const cacheKey = createGeneratedAvatarCacheKey([
        params.id,
        params.monochrome ? 'monochrome' : 'color',
        selectedVariant ?? 'auto',
        themeSignature(params.theme),
    ]);
    const memory = readAvatarXmlFromMemory(cacheKey);
    if (memory) return memory;

    const stored = readAvatarXmlFromStore(cacheKey);
    if (stored) {
        writeAvatarXmlToMemory(cacheKey, stored);
        return stored;
    }

    const model = deriveMeshGradientAvatar({
        id: params.id,
        size: RENDER_SIZE,
        monochrome: params.monochrome,
        theme: params.theme,
        patternVariant: selectedVariant && selectedVariant !== 'auto' ? selectedVariant : undefined,
    });
    const xml = renderMeshGradientSvg(model, RENDER_SIZE);
    writeAvatarXmlToMemory(cacheKey, xml);
    writeAvatarXmlToStore(cacheKey, xml);
    return xml;
}
