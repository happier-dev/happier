import { z } from 'zod';

export const AVATAR_STYLE_IDS = [
    'pixelated',
    'gradient',
    'brutalist',
    'meshGradient',
    'meshGradientOrganic',
    'meshGradientRows',
    'meshGradientColumns',
    'meshGradientDiagonal',
    'meshGradientOval',
    'meshGradientWaves',
    'meshGradientSoftNoise',
    'photoGradient',
    'photoGradientRows',
    'photoGradientColumns',
    'photoGradientDiagonal',
    'photoGradientWaves',
    'photoGradientOval',
    'photoGradientValueNoise',
    'photoGradientVoronoi',
    'photoGradientMeshGrid',
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const AvatarStyleIdSchema = z.enum(AVATAR_STYLE_IDS);

export const DEFAULT_AVATAR_STYLE_ID = 'meshGradientColumns' satisfies AvatarStyleId;
