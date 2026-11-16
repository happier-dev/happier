import { z } from '../../zodRuntimePolicy.js';
import { parseThemeProfileDocument, type ThemeProfileDocument } from './themeProfiles.js';

export const THEME_PROFILE_EXPORT_KIND = 'happier.themeProfile' as const;
export const THEME_PROFILE_FILE_SCHEMA_VERSION = 1 as const;

/** The file envelope is versioned separately from its retained presentation. */
export const ThemeProfileFileEnvelopeSchema = z.object({
    kind: z.literal(THEME_PROFILE_EXPORT_KIND),
    schemaVersion: z.literal(THEME_PROFILE_FILE_SCHEMA_VERSION),
    profile: z.unknown(),
});

export type ThemeProfileFile = Readonly<{
    kind: typeof THEME_PROFILE_EXPORT_KIND;
    schemaVersion: typeof THEME_PROFILE_FILE_SCHEMA_VERSION;
    profile: unknown;
}>;

export function createThemeProfileFile(profile: unknown): ThemeProfileFile {
    return { kind: THEME_PROFILE_EXPORT_KIND, schemaVersion: THEME_PROFILE_FILE_SCHEMA_VERSION, profile };
}

export type ThemeProfileFileReadResult =
    | Readonly<{ ok: true; document: ThemeProfileDocument }>
    | Readonly<{ ok: false; error: 'unsupportedSchema' | 'invalidProfile' }>;

/** MODEL owns profile admission; no portable presentation fields are rebuilt. */
export function parseThemeProfileFile(value: unknown): ThemeProfileFileReadResult {
    const envelope = ThemeProfileFileEnvelopeSchema.safeParse(value);
    if (!envelope.success) return { ok: false, error: 'unsupportedSchema' };
    const parsed = parseThemeProfileDocument(envelope.data.profile);
    return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: 'invalidProfile' };
}
