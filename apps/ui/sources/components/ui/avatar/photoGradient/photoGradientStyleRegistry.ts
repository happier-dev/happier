import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

type PhotoGradientStyleId = Extract<AvatarStyleId, `photoGradient${string}`>;

export type PhotoGradientRenderMode = 'sharpBezier' | 'softBezier' | 'meshGrid';
export type PhotoGradientWarpVariant = 'auto' | 'rows' | 'columns' | 'diagonal' | 'waves' | 'oval' | 'valueNoise' | 'voronoi';

export type PhotoGradientStyleDefinition = Readonly<{
    id: AvatarStyleId;
    renderMode: PhotoGradientRenderMode;
    warpVariant: PhotoGradientWarpVariant;
    fallbackStyleId: AvatarStyleId;
}>;

const PHOTO_GRADIENT_STYLE_DEFINITIONS = {
    photoGradient: {
        id: 'photoGradient',
        renderMode: 'sharpBezier',
        warpVariant: 'auto',
        fallbackStyleId: 'meshGradient',
    },
    photoGradientRows: {
        id: 'photoGradientRows',
        renderMode: 'sharpBezier',
        warpVariant: 'rows',
        fallbackStyleId: 'meshGradientRows',
    },
    photoGradientColumns: {
        id: 'photoGradientColumns',
        renderMode: 'sharpBezier',
        warpVariant: 'columns',
        fallbackStyleId: 'meshGradientColumns',
    },
    photoGradientDiagonal: {
        id: 'photoGradientDiagonal',
        renderMode: 'sharpBezier',
        warpVariant: 'diagonal',
        fallbackStyleId: 'meshGradientDiagonal',
    },
    photoGradientWaves: {
        id: 'photoGradientWaves',
        renderMode: 'softBezier',
        warpVariant: 'waves',
        fallbackStyleId: 'meshGradientWaves',
    },
    photoGradientOval: {
        id: 'photoGradientOval',
        renderMode: 'softBezier',
        warpVariant: 'oval',
        fallbackStyleId: 'meshGradientOval',
    },
    photoGradientValueNoise: {
        id: 'photoGradientValueNoise',
        renderMode: 'sharpBezier',
        warpVariant: 'valueNoise',
        fallbackStyleId: 'meshGradientSoftNoise',
    },
    photoGradientVoronoi: {
        id: 'photoGradientVoronoi',
        renderMode: 'sharpBezier',
        warpVariant: 'voronoi',
        fallbackStyleId: 'meshGradientOrganic',
    },
    photoGradientMeshGrid: {
        id: 'photoGradientMeshGrid',
        renderMode: 'meshGrid',
        warpVariant: 'columns',
        fallbackStyleId: 'meshGradientColumns',
    },
} as const satisfies Record<PhotoGradientStyleId, PhotoGradientStyleDefinition>;

function isPhotoGradientStyleId(styleId: AvatarStyleId): styleId is PhotoGradientStyleId {
    return Object.prototype.hasOwnProperty.call(PHOTO_GRADIENT_STYLE_DEFINITIONS, styleId);
}

export function getPhotoGradientStyleDefinition(styleId: AvatarStyleId | undefined): PhotoGradientStyleDefinition {
    if (!styleId) return PHOTO_GRADIENT_STYLE_DEFINITIONS.photoGradient;
    return isPhotoGradientStyleId(styleId)
        ? PHOTO_GRADIENT_STYLE_DEFINITIONS[styleId]
        : PHOTO_GRADIENT_STYLE_DEFINITIONS.photoGradient;
}

export function getPhotoGradientFallbackStyleId(styleId: AvatarStyleId | undefined): AvatarStyleId {
    return getPhotoGradientStyleDefinition(styleId).fallbackStyleId;
}
