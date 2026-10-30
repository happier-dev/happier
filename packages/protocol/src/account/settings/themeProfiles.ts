import { migrateThemeProfileOverrideTokenIds } from './themeProfileTokens.js';
import * as z from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { isValidThemeProfileColorValue } from './themeProfileColors.js';

export const THEME_PROFILE_ID_MAX_LENGTH = 96;
export const THEME_PROFILE_NAME_MAX_LENGTH = 64;
export const THEME_PROFILE_MAX_OVERRIDES_PER_MODE = 300;
export const BUILT_IN_THEME_PROFILE_PRESET_IDS = [
    'premiumDark',
    'pitchDark',
    'sunsetDark',
    'tokyoNight',
    'nightDark',
    'classicDark',
    'graphiteDark',
    'catppuccinMocha',
    'catppuccinMacchiato',
    'catppuccinFrappe',
    'oneDarkPro',
    'monokaiPro',
    'githubDark',
    'darkModern',
    'premiumLight',
    'paperLight',
    'catppuccinLatte',
    'githubLight',
] as const;
export type BuiltInThemeProfilePresetId = typeof BUILT_IN_THEME_PROFILE_PRESET_IDS[number];
const builtInIds = new Set<string>(BUILT_IN_THEME_PROFILE_PRESET_IDS);
const reservedIds = new Set<string>(['adaptive', 'light', 'dark', 'new', ...BUILT_IN_THEME_PROFILE_PRESET_IDS]);
export function isBuiltInThemeProfilePresetId(value: string | null | undefined): value is BuiltInThemeProfilePresetId {
    return typeof value === 'string' && builtInIds.has(value);
}
export function isReservedThemeProfileId(value: string | null | undefined): boolean {
    return typeof value === 'string' && reservedIds.has(value);
}
export const ThemeProfileIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(THEME_PROFILE_ID_MAX_LENGTH), z.regex(/^[A-Za-z0-9_-]+$/));
export const ThemeProfileNameSchema = z.string().check(z.refine((name) => !/[\u0000-\u001F\u007F]/.test(name)), z.trim(), z.minLength(1), z.maxLength(THEME_PROFILE_NAME_MAX_LENGTH));
export const ThemeProfileTokenIdSchema = z.string().check(z.minLength(1));
export const ThemeProfileColorSchema = z.string().check(z.refine(isValidThemeProfileColorValue));
// Token ids are opaque persistence keys. The UI token registry decides which ones
// this build can apply; retaining newer ids prevents unrelated edits losing them.
export const ThemeProfileColorOverridesSchema = z.pipe(
    z.record(ThemeProfileTokenIdSchema, ThemeProfileColorSchema).check(z.refine((overrides) => Object.keys(overrides).length <= THEME_PROFILE_MAX_OVERRIDES_PER_MODE)),
    z.transform((overrides) => migrateThemeProfileOverrideTokenIds(overrides).overrides),
);
export const ThemeProfileV1Schema = z.strictObject({
    schemaVersion: z.literal(1),
    id: ThemeProfileIdSchema.check(z.refine((id) => !isReservedThemeProfileId(id))),
    name: ThemeProfileNameSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    base: z.strictObject({ light: z.literal('light'), dark: z.literal('dark') }),
    assetAppearance: z.optional(z.enum(['light', 'dark'])),
    overrides: z.strictObject({ light: ThemeProfileColorOverridesSchema, dark: ThemeProfileColorOverridesSchema }),
});
export type ThemeProfileV1 = z.infer<typeof ThemeProfileV1Schema>;
export const ThemeProfileStoredSchema = createStoredReadSchema(ThemeProfileV1Schema);
// The Account document owns the byte budget; device creation limits never truncate reads.
export const ThemeProfileLibrarySchema: z.ZodMiniType<readonly ThemeProfileV1[]> = z.array(ThemeProfileV1Schema).check(z.refine((profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length));
// Legacy libraries recover valid siblings; mutation admission remains strict.
defineStoredReadProjection(ThemeProfileLibrarySchema, () => z.pipe(z.unknown(), z.transform((value): ThemeProfileV1[] => {
    if (!Array.isArray(value)) return [];
    const profiles: ThemeProfileV1[] = [];
    const seen = new Set<string>();
    for (const source of value) {
        const parsed = ThemeProfileStoredSchema.safeParse(source);
        if (!parsed.success || seen.has(parsed.data.id)) continue;
        profiles.push(parsed.data);
        seen.add(parsed.data.id);
    }
    return profiles;
})));
export const ThemeProfileLibraryStoredSchema = createStoredReadSchema(ThemeProfileLibrarySchema);

export { isValidThemeProfileColorValue, normalizeOpaqueThemeHexColor } from './themeProfileColors.js';

export { migrateThemeProfileOverrideTokenId, migrateThemeProfileOverrideTokenIds } from './themeProfileTokens.js';
