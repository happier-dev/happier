import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import type { SessionRowDensity } from './resolveSessionRowPresentation';

export type SessionLineageRowDensity = 'detailed' | 'cozy' | 'narrow';

export type SessionLineageAppearancePreset = Readonly<{
    density?: SessionLineageRowDensity;
    avatarStyle?: AvatarStyleId;
}>;

export type SessionLineageAppearancePresets = Readonly<{
    parent?: SessionLineageAppearancePreset;
    child?: SessionLineageAppearancePreset;
}>;

export function resolveSessionLineageBaseDensity(input: Readonly<{
    baseDensity?: SessionLineageRowDensity;
    density: SessionRowDensity;
}>): SessionLineageRowDensity {
    return input.baseDensity ?? (input.density === 'minimal'
        ? 'narrow'
        : input.density === 'compact' ? 'cozy' : 'detailed');
}

function resolveSessionRowDensity(density: SessionLineageRowDensity): SessionRowDensity {
    return density === 'narrow' ? 'minimal' : density === 'cozy' ? 'compact' : 'default';
}

export function resolveSessionLineageRowAppearance(input: Readonly<{
    enabled: boolean;
    nestingDepth: number;
    hasChildren: boolean;
    baseDensity: SessionLineageRowDensity;
    presets: SessionLineageAppearancePresets;
}>): Readonly<{ density: SessionLineageRowDensity; rowDensity: SessionRowDensity; avatarStyle: AvatarStyleId | null }> {
    if (!input.enabled) return {
        density: input.baseDensity,
        rowDensity: resolveSessionRowDensity(input.baseDensity),
        avatarStyle: null,
    };
    const preset = input.nestingDepth > 0
        ? input.presets.child
        : input.hasChildren
            ? input.presets.parent
            : undefined;
    const density = preset?.density ?? input.baseDensity;
    return {
        density,
        rowDensity: resolveSessionRowDensity(density),
        avatarStyle: preset?.avatarStyle ?? null,
    };
}
