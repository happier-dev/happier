import {
    AVATAR_STYLE_IDS,
    type AvatarStyleId,
} from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import type { MeshGradientPatternVariant } from './meshGradient/meshGradientTypes';
import type { TranslationKeyNoParams } from '@/text';

type AvatarStyleLabelKey = Extract<TranslationKeyNoParams, `settingsAppearance.avatarOptions.${string}`>;

export type AvatarStyleOption = Readonly<{
    id: AvatarStyleId;
    labelKey: AvatarStyleLabelKey;
}>;

export const FALLBACK_AVATAR_STYLE_ID = 'gradient' satisfies AvatarStyleId;

export type MeshGradientStyleVariant = MeshGradientPatternVariant | 'auto';

export const AVATAR_STYLE_OPTIONS = [
    { id: 'pixelated', labelKey: 'settingsAppearance.avatarOptions.pixelated' },
    { id: 'gradient', labelKey: 'settingsAppearance.avatarOptions.gradient' },
    { id: 'brutalist', labelKey: 'settingsAppearance.avatarOptions.brutalist' },
    { id: 'meshGradient', labelKey: 'settingsAppearance.avatarOptions.meshGradient' },
    { id: 'meshGradientOrganic', labelKey: 'settingsAppearance.avatarOptions.meshGradientOrganic' },
    { id: 'meshGradientRows', labelKey: 'settingsAppearance.avatarOptions.meshGradientRows' },
    { id: 'meshGradientColumns', labelKey: 'settingsAppearance.avatarOptions.meshGradientColumns' },
    { id: 'meshGradientDiagonal', labelKey: 'settingsAppearance.avatarOptions.meshGradientDiagonal' },
    { id: 'meshGradientOval', labelKey: 'settingsAppearance.avatarOptions.meshGradientOval' },
    { id: 'meshGradientWaves', labelKey: 'settingsAppearance.avatarOptions.meshGradientWaves' },
    { id: 'meshGradientSoftNoise', labelKey: 'settingsAppearance.avatarOptions.meshGradientSoftNoise' },
    { id: 'photoGradient', labelKey: 'settingsAppearance.avatarOptions.photoGradient' },
    { id: 'photoGradientRows', labelKey: 'settingsAppearance.avatarOptions.photoGradientRows' },
    { id: 'photoGradientColumns', labelKey: 'settingsAppearance.avatarOptions.photoGradientColumns' },
    { id: 'photoGradientDiagonal', labelKey: 'settingsAppearance.avatarOptions.photoGradientDiagonal' },
    { id: 'photoGradientWaves', labelKey: 'settingsAppearance.avatarOptions.photoGradientWaves' },
    { id: 'photoGradientOval', labelKey: 'settingsAppearance.avatarOptions.photoGradientOval' },
    { id: 'photoGradientValueNoise', labelKey: 'settingsAppearance.avatarOptions.photoGradientValueNoise' },
    { id: 'photoGradientVoronoi', labelKey: 'settingsAppearance.avatarOptions.photoGradientVoronoi' },
    { id: 'photoGradientMeshGrid', labelKey: 'settingsAppearance.avatarOptions.photoGradientMeshGrid' },
] as const satisfies readonly AvatarStyleOption[];

const MESH_GRADIENT_VARIANT_BY_STYLE_ID: Partial<Record<AvatarStyleId, MeshGradientStyleVariant>> = {
    meshGradient: 'auto',
    meshGradientOrganic: 'organic',
    meshGradientRows: 'rows',
    meshGradientColumns: 'columns',
    meshGradientDiagonal: 'diagonal',
    meshGradientOval: 'oval',
    meshGradientWaves: 'waves',
    meshGradientSoftNoise: 'softNoise',
};

const AVATAR_STYLE_ID_SET = new Set<string>(AVATAR_STYLE_IDS);
const AVATAR_STYLE_OPTION_BY_ID = new Map<AvatarStyleId, AvatarStyleOption>(
    AVATAR_STYLE_OPTIONS.map((option) => [option.id, option]),
);

export function isAvatarStyleId(value: string): value is AvatarStyleId {
    return AVATAR_STYLE_ID_SET.has(value);
}

export function normalizeAvatarStyleId(value: string): AvatarStyleId {
    return isAvatarStyleId(value) ? value : FALLBACK_AVATAR_STYLE_ID;
}

export function getAvatarStyleOption(styleId: AvatarStyleId): AvatarStyleOption {
    const option = AVATAR_STYLE_OPTION_BY_ID.get(styleId);
    if (!option) {
        return AVATAR_STYLE_OPTION_BY_ID.get(FALLBACK_AVATAR_STYLE_ID)!;
    }
    return option;
}

export function getNextAvatarStyleId(styleId: AvatarStyleId): AvatarStyleId {
    const currentIndex = AVATAR_STYLE_OPTIONS.findIndex((option) => option.id === styleId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % AVATAR_STYLE_OPTIONS.length;
    return AVATAR_STYLE_OPTIONS[nextIndex].id;
}

export function getMeshGradientVariantForAvatarStyle(styleId: AvatarStyleId): MeshGradientStyleVariant | null {
    return MESH_GRADIENT_VARIANT_BY_STYLE_ID[styleId] ?? null;
}
