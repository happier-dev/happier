import { z } from 'zod';

const SUPPORTED_LANGUAGE_HINTS = [
  'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it', 'ja',
  'ko', 'pt-BR', 'pt-PT', 'ru', 'es-MX', 'es-ES', 'tr', 'vi',
] as const;

const XaiKeytermsSchema = z.array(z.string().trim().min(1).max(50)).max(100)
  .superRefine((values, context) => {
    const normalized = values.map((value) => value.toLocaleLowerCase('en-US'));
    if (new Set(normalized).size !== values.length) context.addIssue({ code: 'custom', message: 'Expected unique keyterms' });
  });

const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pinned'), id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('moving_alias'), id: z.literal('grok-voice-latest') }).strict(),
]);

const VoiceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('custom'), id: z.string().trim().min(1).max(256) }).strict(),
]);

export const XAI_REALTIME_DEFAULT_SETTINGS = Object.freeze({
  model: Object.freeze({ kind: 'pinned' as const, id: 'grok-voice-think-fast-2.0' }),
  voice: Object.freeze({ kind: 'catalog' as const, id: 'eve' }),
  instructions: '',
  reasoningEffort: 'high' as const,
  outputSpeed: 1,
  transcription: Object.freeze({ languageHint: null, keyterms: Object.freeze([] as string[]) }),
  turnDetection: Object.freeze({
    mode: 'server_vad' as const,
    threshold: null,
    silenceDurationMs: null,
    prefixPaddingMs: null,
    idleTimeoutMs: null,
  }),
  resumptionEnabled: false,
});

function createDefaultKeyterms(): string[] {
  return [...XAI_REALTIME_DEFAULT_SETTINGS.transcription.keyterms];
}

function createDefaultTranscriptionSettings() {
  return {
    languageHint: XAI_REALTIME_DEFAULT_SETTINGS.transcription.languageHint,
    keyterms: createDefaultKeyterms(),
  };
}

export const XaiRealtimeSettingsV1Schema = z.object({
  model: ModelSelectionSchema.default(XAI_REALTIME_DEFAULT_SETTINGS.model),
  voice: VoiceSelectionSchema.default(XAI_REALTIME_DEFAULT_SETTINGS.voice),
  instructions: z.string().trim().max(10_000).nullable().default(''),
  reasoningEffort: z.enum(['high', 'none']).default('high'),
  outputSpeed: z.number().min(0.7).max(1.5).default(1),
  transcription: z.object({
    languageHint: z.enum(SUPPORTED_LANGUAGE_HINTS).nullable().default(null),
    keyterms: XaiKeytermsSchema.default(createDefaultKeyterms),
  }).strict().default(createDefaultTranscriptionSettings),
  turnDetection: z.object({
    mode: z.literal('server_vad').default('server_vad'),
    threshold: z.number().min(0.1).max(0.9).nullable().default(null),
    silenceDurationMs: z.number().int().min(0).max(10_000).nullable().default(null),
    prefixPaddingMs: z.number().int().min(0).max(10_000).nullable().default(null),
    idleTimeoutMs: z.number().int().min(1).max(10 * 60_000).nullable().default(null),
  }).strict().default(XAI_REALTIME_DEFAULT_SETTINGS.turnDetection),
  resumptionEnabled: z.boolean().default(false),
}).strict();

export type XaiRealtimeSettingsV1 = z.infer<typeof XaiRealtimeSettingsV1Schema>;
export const XAI_SUPPORTED_LANGUAGE_HINTS = SUPPORTED_LANGUAGE_HINTS;
