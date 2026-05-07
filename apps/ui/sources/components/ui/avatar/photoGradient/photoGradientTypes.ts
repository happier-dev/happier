import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

import type {
    PhotoGradientRenderMode,
    PhotoGradientWarpVariant,
} from './photoGradientStyleRegistry';

export type PhotoGradientRgbColor = Readonly<{
    r: number;
    g: number;
    b: number;
}>;

export type PhotoGradientControlPoint = Readonly<{
    x: number;
    y: number;
    color: PhotoGradientRgbColor;
}>;

export type PhotoGradientAvatarModel = Readonly<{
    id: string;
    styleId: AvatarStyleId;
    renderMode: PhotoGradientRenderMode;
    warpVariant: PhotoGradientWarpVariant;
    size: number;
    seed: number;
    backgroundColor: PhotoGradientRgbColor;
    points: readonly PhotoGradientControlPoint[];
    noiseRatio: number;
    warpRatio: number;
    warpSize: number;
}>;
