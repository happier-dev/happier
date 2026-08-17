import { z } from 'zod';

/** Read-only v1 migration input. Never use this schema for canonical writes. */
export const GoogleGeminiSttSettingsLegacySchema = z.object({
  apiKey: z.unknown().nullable().default(null),
  model: z.string().trim().min(1).max(256).default('gemini-2.5-flash'),
  language: z.string().trim().min(1).max(64).nullable().default(null),
});

export const GoogleGeminiSttSettingsSchema = z.object({
  model: z.string().trim().min(1).max(256).default('gemini-2.5-flash'),
  language: z.preprocess(
    (value) => value === null ? '' : value,
    z.string().trim().max(64).default(''),
  ),
}).strict();

export type GoogleGeminiSttSettings = z.infer<typeof GoogleGeminiSttSettingsSchema>;

/** Read-only v1 migration input. Never use this schema for canonical writes. */
export const GoogleCloudTtsSettingsLegacySchema = z.object({
  apiKey: z.unknown().nullable().default(null),
  androidCertSha1: z.string().trim().min(1).max(256).nullable().default(null),
  voiceName: z.string().trim().min(1).max(256).nullable().default(null),
  languageCode: z.string().trim().min(1).max(64).nullable().default(null),
  format: z.enum(['mp3', 'wav']).default('mp3'),
  speakingRate: z.number().min(0.25).max(4).nullable().default(null),
  pitch: z.number().min(-20).max(20).nullable().default(null),
});

export const GoogleCloudTtsSettingsSchema = z.object({
  voiceName: z.preprocess(
    (value) => value === null ? '' : value,
    z.string().trim().max(256).default(''),
  ),
  languageCode: z.preprocess(
    (value) => value === null ? '' : value,
    z.string().trim().max(64).default(''),
  ),
  format: z.enum(['mp3', 'wav']).default('mp3'),
  speakingRate: z.preprocess(
    (value) => value === null ? 1 : value,
    z.number().min(0.25).max(4).default(1),
  ),
  pitch: z.preprocess(
    (value) => value === null ? 0 : value,
    z.number().min(-20).max(20).default(0),
  ),
}).strict();

export type GoogleCloudTtsSettings = z.infer<typeof GoogleCloudTtsSettingsSchema>;
export type GoogleGeminiSttSettingsLegacy = z.infer<typeof GoogleGeminiSttSettingsLegacySchema>;
export type GoogleCloudTtsSettingsLegacy = z.infer<typeof GoogleCloudTtsSettingsLegacySchema>;

export const GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS: GoogleGeminiSttSettings = Object.freeze(
  GoogleGeminiSttSettingsSchema.parse({}),
);

export const GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS: GoogleCloudTtsSettings = Object.freeze(
  GoogleCloudTtsSettingsSchema.parse({}),
);
