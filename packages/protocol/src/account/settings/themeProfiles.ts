import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { isJsonObject, normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { isSupportedThemeProfileTokenId, migrateThemeProfileOverrideTokenIds } from './themeProfileTokens.js';
import * as z from '../../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { isValidThemeProfileColorValue } from './themeProfileColors.js';

export const THEME_PROFILE_ID_MAX_LENGTH = 96;
export const THEME_PROFILE_NAME_MAX_LENGTH = 64;
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
// Token ids are opaque persistence keys. The shared token catalog decides which ones
// this build can apply; retaining newer ids prevents unrelated edits losing them.
export const ThemeProfileColorOverridesSchema = z.pipe(
    z.record(ThemeProfileTokenIdSchema, ThemeProfileColorSchema),
    z.transform((overrides) => migrateThemeProfileOverrideTokenIds(overrides).overrides),
);

export type ThemeProfileMode = 'light' | 'dark';
export const ThemeRadiusScaleNameSchema = z.enum(['sharp', 'soft', 'round']);
export type ThemeRadiusScaleName = z.infer<typeof ThemeRadiusScaleNameSchema>;
/** Bundled-font identifier; the font catalog decides support, never a network URL. */
export type ThemeTypefaceId = string;
export const ThemeProfileSeedsSchema = z.strictObject({ canvas: ThemeProfileColorSchema, accent: ThemeProfileColorSchema });
export type ThemeProfileSeeds = z.infer<typeof ThemeProfileSeedsSchema>;
export const ThemeProfileStyleSchema = z.strictObject({ radius: z.optional(ThemeRadiusScaleNameSchema), fontFamily: z.optional(z.string()) });
export type ThemeProfileStyle = z.infer<typeof ThemeProfileStyleSchema>;
export const ThemeProfileSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('yours') }),
    z.strictObject({ kind: z.literal('store'), provenance: RegistryProvenanceV1Schema, contributionId: z.string() }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: asProtocolZod(PluginIdSchema), contributionId: asProtocolZod(PluginContributionLocalIdSchema) }),
    z.strictObject({ kind: z.literal('built-in'), presetId: z.enum(BUILT_IN_THEME_PROFILE_PRESET_IDS) }),
]));
export type ThemeProfileSource = z.infer<typeof ThemeProfileSourceSchema>;

export const ThemeProfileV1Schema = z.strictObject({
    schemaVersion: z.literal(1),
    id: ThemeProfileIdSchema,
    name: ThemeProfileNameSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    base: z.strictObject({ light: z.literal('light'), dark: z.literal('dark') }),
    assetAppearance: z.optional(z.enum(['light', 'dark'])),
    overrides: z.strictObject({ light: ThemeProfileColorOverridesSchema, dark: ThemeProfileColorOverridesSchema }),
    seeds: z.optional(ThemeProfileSeedsSchema),
    style: z.optional(ThemeProfileStyleSchema),
    css: z.optional(z.string()),
    source: z.optional(ThemeProfileSourceSchema),
    requiresAppVersion: z.optional(z.string()),
}).check(z.refine(profile => !isReservedThemeProfileId(profile.id)
    || (profile.source?.kind === 'built-in' && profile.source.presetId === profile.id)));
export type ThemeProfileV1 = z.infer<typeof ThemeProfileV1Schema>;
defineStoredReadProjection(ThemeProfileV1Schema, () => z.pipe(z.unknown(), z.transform((value, context): ThemeProfileV1 => {
    const result = parseThemeProfileDocument(value);
    if (result.ok) return result.document.profile;
    context.issues.push({ code: 'custom', message: result.error, input: value });
    return z.NEVER;
})));
export const ThemeProfileStoredSchema = createStoredReadSchema(ThemeProfileV1Schema);
// Released Account library input retains predecessor cardinality; new saved bodies use Artifacts.
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


export type ThemePresentationCompatibility = Readonly<{
    status: 'supported' | 'partial'; requiresAppVersion?: string; unsupportedPaths: readonly string[];
}>;
export type ThemeProfileDocument = Readonly<{
    profile: ThemeProfileV1;
    raw: Readonly<Record<string, import('../../json/strictJsonValue.js').JsonValue>>;
    compatibility: ThemePresentationCompatibility;
}>;
export const ThemeMiniatureDataSchema = z.strictObject({
    mode: z.enum(['light', 'dark']), canvas: z.string(), raised: z.string(), text: z.string(), mutedText: z.string(),
    accent: z.string(), border: z.string(), radius: ThemeRadiusScaleNameSchema,
});
export type ThemeMiniatureData = Readonly<z.infer<typeof ThemeMiniatureDataSchema>>;
/** Stable selection identity; plugin contributions never masquerade as Artifact ids. */
export const ThemeReferenceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('artifact'), id: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('built-in'), presetId: z.enum(BUILT_IN_THEME_PROFILE_PRESET_IDS) }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: asProtocolZod(PluginIdSchema), contributionId: asProtocolZod(PluginContributionLocalIdSchema) }),
]);
export type ThemeReference = z.infer<typeof ThemeReferenceSchema>;
/** Opaque, client-local last-operation handle; the library never accepts caller-supplied undo effects. */
export type ThemeUndoHandle = string;
export type ThemeUndoContext = Readonly<{
    mode: ThemeProfileMode; previousSelection: ThemeReference | null; appliedSelection: ThemeReference | null;
    createdRecord?: Readonly<{ id: string; revision: number }>;
}>;
export type ThemeLibraryEntry = Readonly<{
    id: string; reference: ThemeReference; name: string; mode: ThemeProfileMode; source: ThemeProfileSource;
    editable: boolean; deletable: boolean; compatibility: ThemePresentationCompatibility; miniature: ThemeMiniatureData;
    /** Additive presentation; older headers expose their single mode and miniature. */
    modes?: readonly ThemeProfileMode[]; miniatures?: Readonly<Partial<Record<ThemeProfileMode, ThemeMiniatureData>>>;
}>;
export type ThemeLibraryChange = Readonly<{
    changedIds: readonly string[]; removedIds: readonly string[]; selectionChangedModes: readonly ThemeProfileMode[];
}>;
export type ThemeLibraryMutationResult = Readonly<{
    entry: ThemeLibraryEntry | null; change: ThemeLibraryChange; undo?: ThemeUndoHandle;
}>;
export interface ThemeProfileLibrary {
    list(): Promise<readonly ThemeLibraryEntry[]>;
    get(reference: ThemeReference): Promise<ThemeProfileDocument | null>;
    save(input: Readonly<{ document: ThemeProfileDocument }>): Promise<ThemeLibraryMutationResult>;
    keep(input: Readonly<{ document: ThemeProfileDocument; mode: ThemeProfileMode }>): Promise<ThemeLibraryMutationResult>;
    delete(id: string, options?: Readonly<{ expectedRevision?: number }>): Promise<ThemeLibraryMutationResult>;
    undo(handle: ThemeUndoHandle): Promise<ThemeLibraryMutationResult>;
    lastUndo(): ThemeUndoHandle | null;
    duplicate(input: Readonly<{ reference: ThemeReference; name?: string }>): Promise<ThemeLibraryMutationResult>;
    select(input: Readonly<{ mode: ThemeProfileMode; reference: ThemeReference | null }>): Promise<ThemeLibraryMutationResult>;
}

export type ThemeProfileDocumentReadResult =
    | Readonly<{ ok: true; document: ThemeProfileDocument }>
    | Readonly<{ ok: false; error: 'invalid_known_envelope' }>;
export type ThemeProfileKnownEdit = Partial<ThemeProfileV1>;

/** Presentation is additive/preserved; identity, source and known value types remain closed. */
export function parseThemeProfileDocument(value: unknown): ThemeProfileDocumentReadResult {
    let raw: import('../../json/strictJsonValue.js').JsonValue;
    try { raw = normalizeStrictJsonValue(value); } catch { return { ok: false, error: 'invalid_known_envelope' }; }
    if (!isJsonObject(raw)) return { ok: false, error: 'invalid_known_envelope' };
    const unsupportedPaths: string[] = [];
    const known: Record<string, unknown> = {};
    const fields = ThemeProfileV1Schema.shape;
    for (const [key, content] of Object.entries(raw)) {
        if (Object.hasOwn(fields, key)) known[key] = content;
        else unsupportedPaths.push(key);
    }
    if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
        return { ok: false, error: 'invalid_known_envelope' };
    }
    if (raw.schemaVersion !== 1) { known.schemaVersion = 1; unsupportedPaths.unshift('schemaVersion'); }
    if (isJsonObject(raw.seeds)) {
        const seeds: Record<string, unknown> = {};
        for (const [key, content] of Object.entries(raw.seeds)) {
            if (Object.hasOwn(ThemeProfileSeedsSchema.shape, key)) seeds[key] = content;
            else unsupportedPaths.push(`seeds.${key}`);
        }
        if (Object.keys(seeds).length) known.seeds = seeds;
        else delete known.seeds;
    }
    if (isJsonObject(raw.style)) {
        const style: Record<string, unknown> = {};
        for (const [key, content] of Object.entries(raw.style)) {
            if (Object.hasOwn(ThemeProfileStyleSchema.shape, key)) style[key] = content;
            else unsupportedPaths.unshift(`style.${key}`);
        }
        if (typeof style.radius === 'string' && !ThemeRadiusScaleNameSchema.safeParse(style.radius).success) {
            unsupportedPaths.unshift('style.radius'); delete style.radius;
        }
        if (Object.keys(style).length) known.style = style;
        else delete known.style;
    }
    const parsed = ThemeProfileV1Schema.safeParse(known);
    if (!parsed.success) return { ok: false, error: 'invalid_known_envelope' };
    return { ok: true, document: {
        profile: parsed.data, raw, compatibility: describeThemeProfileCompatibility(parsed.data, unsupportedPaths),
    } };
}

function describeThemeProfileCompatibility(profile: ThemeProfileV1, unsupportedPaths: string[] = []): ThemePresentationCompatibility {
    for (const [mode, overrides] of Object.entries(profile.overrides)) {
        for (const tokenId of Object.keys(overrides)) {
            if (!isSupportedThemeProfileTokenId(tokenId)) unsupportedPaths.push(`overrides.${mode}.${tokenId}`);
        }
    }
    return { status: unsupportedPaths.length ? 'partial' : 'supported', unsupportedPaths,
        ...(profile.requiresAppVersion ? { requiresAppVersion: profile.requiresAppVersion } : {}) };
}

/** Attach the admitted declaration's plugin identity and portable representation. */
export function createPluginThemeProfileDocument(theme: ThemeProfileV1,
    source: Extract<ThemeProfileSource, { kind: 'plugin' }>): ThemeProfileDocument {
    // Changing the source of a built-in id would invalidate the document's identity.
    if (isReservedThemeProfileId(theme.id)) throw new Error('Invalid admitted plugin theme');
    const profile = { ...theme, source };
    const raw = projectNativeJsonValueForTransport(profile);
    if (!isJsonObject(raw)) throw new TypeError('Theme profile must be an object');
    return { profile, raw, compatibility: describeThemeProfileCompatibility(profile) };
}

const ThemeProfileKnownEditSchema = z.partial(z.strictObject(ThemeProfileV1Schema.shape));

function isUnchangedThemeEdit(document: ThemeProfileDocument, edit: ThemeProfileKnownEdit): boolean {
    for (const key in edit) {
        if (!Object.hasOwn(edit, key)) continue;
        const field = key as keyof ThemeProfileV1;
        const value = edit[field];
        if (!Object.hasOwn(ThemeProfileV1Schema.shape, field) || !Object.hasOwn(document.raw, field)
            || value !== document.profile[field] || value !== document.raw[field]) return false;
    }
    return true;
}

/** Overlay deliberate edits, retaining presentation this build cannot interpret. */
export function mergeThemeProfileDocumentEdit(document: ThemeProfileDocument, edit: ThemeProfileKnownEdit,
    options?: Readonly<{ retainedPresentation?: ThemeProfileDocument; replaceKnownPresentation?: true;
        removeKnownFields?: readonly ('seeds' | 'style' | 'css')[] }>): ThemeProfileDocument {
    const retained = options?.retainedPresentation ?? (options?.replaceKnownPresentation ? document : undefined);
    const plainEdit = !retained && !options?.removeKnownFields?.length;
    if (plainEdit && edit && typeof edit === 'object'
        && (Object.getPrototypeOf(edit) === Object.prototype || Object.getPrototypeOf(edit) === null)
        && isUnchangedThemeEdit(document, edit)) return document;
    const checked = ThemeProfileKnownEditSchema.parse(edit);
    if (plainEdit) {
        const fields = Object.keys(checked) as (keyof ThemeProfileKnownEdit)[];
        if (fields.every(field => {
            if (field === 'schemaVersion') return true;
            const before = document.raw[field];
            const after = checked[field];
            if ((field === 'seeds' || field === 'style') && after && isJsonObject(before)) {
                return Object.entries(after).every(([key, value]) => sameStrictJsonValue(before[key], value)
                    && Object.hasOwn(before, key));
            }
            return Object.hasOwn(document.raw, field) && sameStrictJsonValue(before, after);
        })) return document;
        // Store adds these validated facts to already admitted presentation. A source
        // change on a reserved id still needs the full identity/source refinement.
        if (fields.every(field => (field === 'assetAppearance' || field === 'source') && checked[field] !== undefined)
            && (checked.source === undefined || !isReservedThemeProfileId(document.profile.id))) {
            const rawEdit = normalizeStrictJsonValue(checked);
            if (isJsonObject(rawEdit)) return {
                ...document,
                profile: { ...document.profile, ...checked },
                raw: Object.freeze({ __proto__: null, ...document.raw, ...rawEdit }),
            };
        }
    }
    const unknown = retained ? Object.fromEntries(Object.entries(retained.raw)
        .filter(([key]) => !Object.hasOwn(ThemeProfileV1Schema.shape, key))) : {};
    const retainedSection = (section: 'seeds' | 'style') => {
        const value = retained?.raw[section];
        return isJsonObject(value) ? Object.fromEntries(Object.entries(value)
            .filter(([key]) => retained?.compatibility.unsupportedPaths.includes(`${section}.${key}`))) : {};
    };
    const seeds = retainedSection('seeds');
    const style = retainedSection('style');
    let previous = document.raw;
    if (options?.replaceKnownPresentation) {
        const { seeds: _seeds, style: _style, css: _css, ...envelope } = previous;
        previous = envelope;
    }
    const raw = { ...previous, ...unknown, ...checked, schemaVersion: document.raw.schemaVersion,
        ...(checked.seeds || Object.keys(seeds).length ? { seeds: { ...(isJsonObject(previous.seeds) ? previous.seeds : {}), ...seeds, ...checked.seeds } } : {}),
        ...(checked.style || Object.keys(style).length ? { style: { ...(isJsonObject(previous.style) ? previous.style : {}), ...style, ...checked.style } } : {}),
    };
    const result = parseThemeProfileDocument(raw);
    if (!result.ok) throw new Error('invalid_known_envelope');
    if (!options?.removeKnownFields?.length) return result.document;
    const cleared: Record<string, JsonValue> = { __proto__: null, ...result.document.raw };
    const profile = { ...result.document.profile };
    for (const field of options.removeKnownFields) {
        delete profile[field];
        const value = cleared[field];
        if (field === 'css' || !isJsonObject(value)) {
            delete cleared[field];
            continue;
        }
        const unsupported = Object.entries(value).filter(([key]) =>
            result.document.compatibility.unsupportedPaths.includes(`${field}.${key}`));
        if (unsupported.length) cleared[field] = Object.freeze({ __proto__: null, ...Object.fromEntries(unsupported) });
        else delete cleared[field];
    }
    return { ...result.document, profile, raw: Object.freeze(cleared) };
}
