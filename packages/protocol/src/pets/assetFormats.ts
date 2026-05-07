import { z } from 'zod';

export const PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1 = [
  { extension: 'png', mediaType: 'image/png', spritesheetPath: 'spritesheet.png' },
  { extension: 'webp', mediaType: 'image/webp', spritesheetPath: 'spritesheet.webp' },
] as const;

type PetCanonicalSpritesheetAssetFormatTupleV1 = typeof PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1;
type PetCanonicalSpritesheetAssetFormatV1 = PetCanonicalSpritesheetAssetFormatTupleV1[number];

export type PetCanonicalSpritesheetExtensionV1 = PetCanonicalSpritesheetAssetFormatV1['extension'];
export type PetCanonicalSpritesheetMediaTypeV1 = PetCanonicalSpritesheetAssetFormatV1['mediaType'];
export type PetCanonicalSpritesheetPathV1 = PetCanonicalSpritesheetAssetFormatV1['spritesheetPath'];

const PET_SPRITESHEET_MEDIA_TYPE_BY_PATH_V1 = new Map<PetCanonicalSpritesheetPathV1, PetCanonicalSpritesheetMediaTypeV1>(
  PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1.map((format) => [format.spritesheetPath, format.mediaType]),
);

export const PET_CANONICAL_SPRITESHEET_EXTENSIONS_V1 = PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1.map((format) => format.extension) as [
  PetCanonicalSpritesheetExtensionV1,
  ...PetCanonicalSpritesheetExtensionV1[],
];

export const PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1 = PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1.map((format) => format.mediaType) as [
  PetCanonicalSpritesheetMediaTypeV1,
  ...PetCanonicalSpritesheetMediaTypeV1[],
];

export const PET_CANONICAL_SPRITESHEET_PATHS_V1 = PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1.map((format) => format.spritesheetPath) as [
  PetCanonicalSpritesheetPathV1,
  ...PetCanonicalSpritesheetPathV1[],
];

export function getCanonicalPetSpritesheetMediaTypeV1(
  spritesheetPath: unknown,
): PetCanonicalSpritesheetMediaTypeV1 | undefined {
  if (typeof spritesheetPath !== 'string') {
    return undefined;
  }

  return PET_SPRITESHEET_MEDIA_TYPE_BY_PATH_V1.get(spritesheetPath as PetCanonicalSpritesheetPathV1);
}

export function isCanonicalPetSpritesheetMediaTypePairV1(value: {
  spritesheetPath: unknown;
  mediaType: unknown;
}): value is {
  spritesheetPath: PetCanonicalSpritesheetPathV1;
  mediaType: PetCanonicalSpritesheetMediaTypeV1;
} {
  return getCanonicalPetSpritesheetMediaTypeV1(value.spritesheetPath) === value.mediaType;
}

export const PetCanonicalSpritesheetMediaTypeV1Schema = z.enum(PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1);
export const PetCanonicalSpritesheetPathV1Schema = z.enum(PET_CANONICAL_SPRITESHEET_PATHS_V1);

export const PetCanonicalSpritesheetAssetV1Schema = z
  .object({
    spritesheetPath: PetCanonicalSpritesheetPathV1Schema,
    mediaType: PetCanonicalSpritesheetMediaTypeV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.spritesheetPath,
      mediaType: value.mediaType,
    });
  });

export function appendCanonicalPetSpritesheetMediaTypeIssueV1({
  ctx,
  spritesheetPath,
  mediaType,
  mediaTypePath = ['mediaType'],
}: {
  ctx: z.RefinementCtx;
  spritesheetPath: unknown;
  mediaType: unknown;
  mediaTypePath?: ReadonlyArray<string | number>;
}): void {
  const expectedMediaType = getCanonicalPetSpritesheetMediaTypeV1(spritesheetPath);
  if (!expectedMediaType || mediaType === expectedMediaType) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...mediaTypePath],
    message: `mediaType must match canonical spritesheet format for ${String(spritesheetPath)}`,
  });
}
