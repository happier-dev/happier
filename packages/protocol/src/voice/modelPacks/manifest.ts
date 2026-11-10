import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { assertModelPackFilePathPortable } from './pathSafety.js';

const Sha256HexSchema = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{64}$/i)));

export const ModelPackVoiceCatalogEntrySchema = lazyZodSchema(() => z.object({
  id: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  subtitle: z.optional(z.string().check(z.minLength(1))),
  sid: z.optional(z.number().check(z.int(), z.minimum(0))),
}));
export type ModelPackVoiceCatalogEntry = z.infer<typeof ModelPackVoiceCatalogEntrySchema>;

export const ModelPackKindSchema = lazyZodSchema(() => z.enum(['tts_sherpa', 'stt_sherpa']));
export type ModelPackKind = z.infer<typeof ModelPackKindSchema>;

/**
 * Declarative runtime ABI required by a model pack. The protocol owns stable
 * identifiers only; each execution host independently reports which families
 * it can actually run.
 */
export const ModelPackRuntimeFamilySchema = lazyZodSchema(() => z.enum([
  'sherpa_kokoro_offline',
  'sherpa_zipformer_streaming',
  'sherpa_parakeet_offline',
  'sherpa_moonshine_offline',
]));
export type ModelPackRuntimeFamily = z.infer<typeof ModelPackRuntimeFamilySchema>;

export const ModelPackManifestSchema = lazyZodSchema(() => z.object({
  packId: z.string().check(z.minLength(1)),
  kind: ModelPackKindSchema,
  model: z.string().check(z.minLength(1)),
  version: z.string().check(z.minLength(1)),
  buildId: z.optional(z.string().check(z.minLength(1))),
  publishedAt: z.optional(z.string().check(z.minLength(1))),
  licenseNotices: z.optional(z.array(z.string().check(z.minLength(1)))),
  voices: z.optional(z.array(ModelPackVoiceCatalogEntrySchema)),
  /** Explicit catalog default. Omitted legacy manifests use the first declared voice. */
  defaultVoiceId: z.optional(z.string().check(z.minLength(1))),
  /** Model-owned phonemizer configuration, consumed by every sherpa host. */
  frontend: z.optional(z.strictObject({
    lang: z.string(),
    lexicon: z.optional(z.string().check(z.minLength(1))),
  }).check(z.refine((frontend) => Boolean(frontend.lang.trim() || frontend.lexicon), {
    message: 'Kokoro requires a language or lexicon.',
  }))),
  files: z
    .array(
      z.object({
        path: z.string().check(z.minLength(1)),
        url: z.string().check(z.url()),
        sha256: Sha256HexSchema,
        sizeBytes: z.number().check(z.int(), z.minimum(0)),
      }),
    ).check(z.minLength(1)),
}).check(z.superRefine((manifest, ctx) => {
  if (manifest.frontend?.lexicon) {
    const lexicon = manifest.frontend.lexicon;
    try {
      assertModelPackFilePathPortable(lexicon);
      if (!manifest.files.some((file) => file.path === lexicon)) throw new Error('undeclared_lexicon');
    } catch {
      ctx.addIssue({ code: 'custom', path: ['frontend', 'lexicon'], message: 'The lexicon must be an integrity-declared pack file.' });
    }
  }
  if (
    manifest.defaultVoiceId
    && !(manifest.voices ?? []).some((voice) => voice.id === manifest.defaultVoiceId)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultVoiceId'],
      message: 'The default voice must identify a declared voice.',
    });
  }
})));
export type ModelPackManifest = z.infer<typeof ModelPackManifestSchema>;

export function parseModelPackManifest(input: unknown): ModelPackManifest {
  return ModelPackManifestSchema.parse(input);
}
