import type * as React from 'react';

import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

import { AvatarBrutalist } from './AvatarBrutalist';
import { AvatarGradient } from './AvatarGradient';
import { AvatarSkia } from './AvatarSkia';
import { AvatarMeshGradient } from './meshGradient/AvatarMeshGradient';
import { AvatarPhotoGradient } from './photoGradient/AvatarPhotoGradient';

export type GeneratedAvatarProps = Readonly<{
    id: string;
    styleId?: AvatarStyleId;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}>;

const GENERATED_AVATAR_COMPONENTS = {
    pixelated: AvatarSkia,
    gradient: AvatarGradient,
    brutalist: AvatarBrutalist,
    meshGradient: AvatarMeshGradient,
    meshGradientOrganic: AvatarMeshGradient,
    meshGradientRows: AvatarMeshGradient,
    meshGradientColumns: AvatarMeshGradient,
    meshGradientDiagonal: AvatarMeshGradient,
    meshGradientOval: AvatarMeshGradient,
    meshGradientWaves: AvatarMeshGradient,
    meshGradientSoftNoise: AvatarMeshGradient,
    photoGradient: AvatarPhotoGradient,
    photoGradientRows: AvatarPhotoGradient,
    photoGradientColumns: AvatarPhotoGradient,
    photoGradientDiagonal: AvatarPhotoGradient,
    photoGradientWaves: AvatarPhotoGradient,
    photoGradientOval: AvatarPhotoGradient,
    photoGradientValueNoise: AvatarPhotoGradient,
    photoGradientVoronoi: AvatarPhotoGradient,
    photoGradientMeshGrid: AvatarPhotoGradient,
} satisfies Record<AvatarStyleId, React.ComponentType<GeneratedAvatarProps>>;

export function getGeneratedAvatarComponentForStyle(
    styleId: AvatarStyleId,
): React.ComponentType<GeneratedAvatarProps> {
    return GENERATED_AVATAR_COMPONENTS[styleId];
}
