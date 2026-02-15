import { z } from 'zod';

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/i);

const ModelPackVoiceCatalogEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  sid: z.number().int().min(0).optional(),
});

export const ModelPackKindSchema = z.enum(['tts_sherpa', 'stt_sherpa']);
export type ModelPackKind = z.infer<typeof ModelPackKindSchema>;

export const ModelPackManifestSchema = z.object({
  packId: z.string().min(1),
  kind: ModelPackKindSchema,
  model: z.string().min(1),
  version: z.string().min(1),
  buildId: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  licenseNotices: z.array(z.string().min(1)).optional(),
  voices: z.array(ModelPackVoiceCatalogEntrySchema).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        url: z.string().url(),
        sha256: Sha256HexSchema,
        sizeBytes: z.number().int().min(0),
      }),
    )
    .min(1),
});

export type ModelPackManifest = z.infer<typeof ModelPackManifestSchema>;

export function parseModelPackManifest(input: unknown): ModelPackManifest {
  return ModelPackManifestSchema.parse(input);
}
