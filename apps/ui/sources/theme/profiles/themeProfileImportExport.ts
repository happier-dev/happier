import {
    DEFAULT_IMPORTED_THEME_PROFILE_NAME,
    THEME_PROFILE_EXPORT_KIND,
    THEME_PROFILE_ID_MAX_LENGTH,
    THEME_PROFILE_ID_PREFIX,
    THEME_PROFILE_MAX_JSON_BYTES,
    THEME_PROFILE_MAX_OVERRIDES_PER_MODE,
    THEME_PROFILE_MAX_PROFILES,
    THEME_PROFILE_NAME_MAX_LENGTH,
    THEME_PROFILE_SCHEMA_VERSION,
} from './themeProfileConstants';
import { isBuiltInThemeProfilePresetId } from './builtInThemeProfiles';
import { isValidThemeProfileColorValue } from './themeProfileColorValidation';
import { getThemeProfileTokenDefinition, THEME_PROFILE_TOKEN_DEFINITIONS } from './themeProfileTokenRegistry';
import { resolveThemeProfile } from './resolveThemeProfile';
import { readThemeProfilePathValue } from './themeProfilePathAccess';
import { inferThemeProfileAssetAppearance, isThemeProfileAssetAppearance } from './themeProfileAssetAppearance';
import { resolveExternalThemeProfileImportProfile } from './themeProfileExternalThemeImport';
import type { ThemeProfileColorOverrides, ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

export { getSupportedThemeProfileImportFormats } from './themeProfileExternalThemeImport';

export type ThemeProfileImportWarning =
    | Readonly<{ code: 'unknownToken'; tokenId: string; mode: ThemeProfileMode }>
    | Readonly<{ code: 'invalidColor'; tokenId: string; mode: ThemeProfileMode }>
    | Readonly<{ code: 'migratedToken'; tokenId: string; migratedTokenId: string; mode: ThemeProfileMode }>;

export type ThemeProfileImportResult =
    | Readonly<{ ok: true; profile: ThemeProfileV1; warnings: readonly ThemeProfileImportWarning[] }>
    | Readonly<{ ok: false; error: 'invalidJson' | 'unsupportedSchema' | 'invalidProfile' | 'tooLarge' }>;

type ImportOptions = Readonly<{
    now: string;
    existingProfileIds?: ReadonlySet<string>;
    generateId?: () => string;
}>;

type ThemeProfileExportPayload = Readonly<{
    kind: typeof THEME_PROFILE_EXPORT_KIND;
    schemaVersion: typeof THEME_PROFILE_SCHEMA_VERSION;
    profile: ThemeProfileV1;
}>;

type ExportThemeProfileOptions = Readonly<{
    mode?: ThemeProfileMode;
    includeResolvedValues?: boolean;
}>;

const DEPRECATED_TOKEN_ID_MIGRATIONS: Readonly<Record<string, string>> = {
    'groupped.background': 'background.canvas',
    surfaceHigh: 'surface.inset',
    surfaceHighest: 'surface.elevated',
    warningCritical: 'state.danger.foreground',
    deleteAction: 'state.danger.foreground',
    syntaxKeyword: 'syntax.keyword',
    syntaxString: 'syntax.string',
    syntaxComment: 'syntax.comment',
    syntaxNumber: 'syntax.number',
    syntaxFunction: 'syntax.function',
    gitAddedText: 'versionControl.added.foreground',
    gitRemovedText: 'versionControl.removed.foreground',
};

const migrateThemeProfileOverrideTokenId = (tokenId: string): string | undefined => DEPRECATED_TOKEN_ID_MIGRATIONS[tokenId];

const MODES = ['light', 'dark'] as const satisfies readonly ThemeProfileMode[];
const ROUTE_SAFE_THEME_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESERVED_BASE_THEME_PROFILE_IDS = new Set(['adaptive', 'light', 'dark', 'new']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stableStringify = (value: unknown): string => JSON.stringify(value, null, 2);

const getUtf8ByteLength = (value: string): number => {
    let bytes = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) continue;
        if (codePoint <= 0x7F) bytes += 1;
        else if (codePoint <= 0x7FF) bytes += 2;
        else if (codePoint <= 0xFFFF) bytes += 3;
        else bytes += 4;
    }
    return bytes;
};

export const migrateThemeProfileOverrideTokenIds = (overrides: ThemeProfileColorOverrides): Readonly<{
    overrides: ThemeProfileColorOverrides;
    migratedTokenIds: readonly string[];
}> => {
    const nextOverrides: Record<string, string> = {};
    const migratedTokenIds: string[] = [];

    for (const [tokenId, value] of Object.entries(overrides)) {
        const migratedTokenId = migrateThemeProfileOverrideTokenId(tokenId);
        if (migratedTokenId) {
            if (Object.prototype.hasOwnProperty.call(overrides, migratedTokenId)) {
                migratedTokenIds.push(tokenId);
                continue;
            }
            nextOverrides[migratedTokenId] = value;
            migratedTokenIds.push(tokenId);
            continue;
        }

        nextOverrides[tokenId] = value;
    }

    return { overrides: nextOverrides, migratedTokenIds };
};

type SanitizeOverridesOptions = Readonly<{
    defaultBlankName?: boolean;
    rejectInvalidColors?: boolean;
    rejectTooManyOverrides?: boolean;
}>;

type SanitizeOverridesResult = Readonly<{
    overrides: ThemeProfileColorOverrides;
    invalid: boolean;
}>;

export const sanitizeThemeProfileName = (name: unknown, options: SanitizeOverridesOptions = {}): string | null => {
    if (typeof name !== 'string') return null;

    if (/[\u0000-\u001F\u007F]/.test(name)) return null;
    const normalized = name.trim();
    if (normalized.length === 0) {
        return options.defaultBlankName === true ? DEFAULT_IMPORTED_THEME_PROFILE_NAME : null;
    }
    if (normalized.length > THEME_PROFILE_NAME_MAX_LENGTH) return null;
    return normalized;
};

export const isRouteSafeThemeProfileId = (id: string): boolean => (
    id.length <= THEME_PROFILE_ID_MAX_LENGTH
    && ROUTE_SAFE_THEME_PROFILE_ID_PATTERN.test(id)
);

export const isReservedThemeProfileId = (id: string | null | undefined): boolean => (
    typeof id === 'string'
    && (RESERVED_BASE_THEME_PROFILE_IDS.has(id) || isBuiltInThemeProfilePresetId(id))
);

const fallbackGenerateId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${THEME_PROFILE_ID_PREFIX}${crypto.randomUUID()}`;
    }

    return `${THEME_PROFILE_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const sanitizeId = (id: unknown, options: ImportOptions): string => {
    const sourceId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : fallbackGenerateId();
    if (
        isRouteSafeThemeProfileId(sourceId)
        && !isReservedThemeProfileId(sourceId)
        && !options.existingProfileIds?.has(sourceId)
    ) {
        return sourceId;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = (options.generateId ?? fallbackGenerateId)();
        if (
            isRouteSafeThemeProfileId(candidate)
            && !isReservedThemeProfileId(candidate)
            && !options.existingProfileIds?.has(candidate)
        ) {
            return candidate;
        }
    }

    return fallbackGenerateId();
};

const sanitizeOverrides = (
    sourceOverrides: unknown,
    mode: ThemeProfileMode,
    warnings: ThemeProfileImportWarning[],
    options: SanitizeOverridesOptions = {},
): SanitizeOverridesResult => {
    if (!isRecord(sourceOverrides)) return { overrides: {}, invalid: false };

    if (options.rejectTooManyOverrides && Object.keys(sourceOverrides).length > THEME_PROFILE_MAX_OVERRIDES_PER_MODE) {
        return { overrides: {}, invalid: true };
    }

    const migrated = migrateThemeProfileOverrideTokenIds(
        Object.fromEntries(Object.entries(sourceOverrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    );
    const migratedTokenIds = new Set(migrated.migratedTokenIds);
    const nextOverrides: Record<string, string> = {};
    let invalid = false;

    for (const [sourceTokenId, value] of Object.entries(sourceOverrides).sort(([left], [right]) => left.localeCompare(right))) {
        const tokenId = migrateThemeProfileOverrideTokenId(sourceTokenId) ?? sourceTokenId;
        if (tokenId !== sourceTokenId && Object.prototype.hasOwnProperty.call(sourceOverrides, tokenId)) {
            warnings.push({ code: 'migratedToken', tokenId: sourceTokenId, migratedTokenId: tokenId, mode });
            continue;
        }
        const definition = getThemeProfileTokenDefinition(tokenId);
        if (!definition) {
            warnings.push({ code: 'unknownToken', tokenId, mode });
            continue;
        }

        if (typeof value !== 'string' || !isValidThemeProfileColorValue(value)) {
            warnings.push({ code: 'invalidColor', tokenId, mode });
            invalid = invalid || options.rejectInvalidColors === true;
            continue;
        }

        nextOverrides[tokenId] = value;
    }

    for (const tokenId of migratedTokenIds) {
        const migratedTokenId = migrateThemeProfileOverrideTokenId(tokenId);
        if (migratedTokenId && nextOverrides[migratedTokenId]) {
            warnings.push({ code: 'migratedToken', tokenId, migratedTokenId, mode });
        }
    }

    return { overrides: nextOverrides, invalid };
};

const sanitizeProfile = (
    profile: ThemeProfileV1,
    options: ImportOptions,
    warnings: ThemeProfileImportWarning[],
    sanitizeOptions: SanitizeOverridesOptions = {},
): ThemeProfileV1 | null => {
    const name = sanitizeThemeProfileName(profile.name, sanitizeOptions);
    if (!name) return null;

    const light = sanitizeOverrides(profile.overrides?.light, 'light', warnings, sanitizeOptions);
    const dark = sanitizeOverrides(profile.overrides?.dark, 'dark', warnings, sanitizeOptions);
    if (light.invalid || dark.invalid) return null;

    const sanitizedProfileWithoutAssetAppearance = {
        schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
        id: sanitizeId(profile.id, options),
        name,
        createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : options.now,
        updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : options.now,
        base: { light: 'light', dark: 'dark' },
        overrides: {
            light: light.overrides,
            dark: dark.overrides,
        },
    } satisfies Omit<ThemeProfileV1, 'assetAppearance'>;

    return {
        ...sanitizedProfileWithoutAssetAppearance,
        assetAppearance: isThemeProfileAssetAppearance(profile.assetAppearance)
            ? profile.assetAppearance
            : inferThemeProfileAssetAppearance(sanitizedProfileWithoutAssetAppearance),
    };
};

const parseProfile = (value: unknown): ThemeProfileV1 | undefined => {
    if (!isRecord(value)) return undefined;
    if (value.schemaVersion !== THEME_PROFILE_SCHEMA_VERSION) return undefined;
    if (!isRecord(value.base) || value.base.light !== 'light' || value.base.dark !== 'dark') return undefined;
    if (!isRecord(value.overrides)) return undefined;

    return value as ThemeProfileV1;
};

const stripJsonComments = (text: string): string => {
    let output = '';
    let inString = false;
    let stringQuote: '"' | '\'' | null = null;
    let isEscaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const nextCharacter = text[index + 1];

        if (inString) {
            output += character;
            if (isEscaped) {
                isEscaped = false;
                continue;
            }
            if (character === '\\') {
                isEscaped = true;
                continue;
            }
            if (character === stringQuote) {
                inString = false;
                stringQuote = null;
            }
            continue;
        }

        if (character === '"' || character === '\'') {
            inString = true;
            stringQuote = character;
            output += character;
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            while (index < text.length && text[index] !== '\n') index += 1;
            output += '\n';
            continue;
        }

        if (character === '/' && nextCharacter === '*') {
            index += 2;
            while (index < text.length - 1 && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
            index += 1;
            continue;
        }

        output += character;
    }

    return output;
};

const parseJsonLikeText = (json: string): unknown | null => {
    try {
        return JSON.parse(json);
    } catch {
        try {
            return JSON.parse(stripJsonComments(json).replace(/,\s*([}\]])/g, '$1'));
        } catch {
            return null;
        }
    }
};

const resolveCompleteModeOverrides = (profile: ThemeProfileV1, mode: ThemeProfileMode): ThemeProfileColorOverrides => {
    const theme = resolveThemeProfile({ mode, profile });
    return Object.fromEntries(
        THEME_PROFILE_TOKEN_DEFINITIONS
            .map((definition) => [definition.id, readThemeProfilePathValue(theme.colors, definition.path)] as const)
            .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
    );
};

const resolveExportProfile = (profile: ThemeProfileV1, options: ExportThemeProfileOptions): ThemeProfileV1 => {
    if (!options.includeResolvedValues || !options.mode) return profile;

    return {
        ...profile,
        overrides: {
            light: options.mode === 'light' ? resolveCompleteModeOverrides(profile, 'light') : {},
            dark: options.mode === 'dark' ? resolveCompleteModeOverrides(profile, 'dark') : {},
        },
    };
};

export const exportThemeProfileToJson = (profile: ThemeProfileV1, options: ExportThemeProfileOptions = {}): string => {
    const warnings: ThemeProfileImportWarning[] = [];
    const sanitizedProfile = sanitizeProfile(resolveExportProfile(profile, options), { now: profile.updatedAt }, warnings);
    if (!sanitizedProfile) {
        throw new Error('Cannot export an invalid theme profile.');
    }

    const payload: ThemeProfileExportPayload = {
        kind: THEME_PROFILE_EXPORT_KIND,
        schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
        profile: sanitizedProfile,
    };

    return stableStringify(payload);
};

export const importThemeProfileFromJson = (json: string, options: ImportOptions): ThemeProfileImportResult => {
    if (getUtf8ByteLength(json) > THEME_PROFILE_MAX_JSON_BYTES) {
        return { ok: false, error: 'tooLarge' };
    }

    const parsed = parseJsonLikeText(json);
    if (parsed === null) {
        return { ok: false, error: 'invalidJson' };
    }

    let parsedProfile: ThemeProfileV1 | null = null;
    if (isRecord(parsed) && parsed.kind === THEME_PROFILE_EXPORT_KIND && parsed.schemaVersion === THEME_PROFILE_SCHEMA_VERSION) {
        parsedProfile = parseProfile(parsed.profile) ?? null;
        if (!parsedProfile) {
            return { ok: false, error: 'invalidProfile' };
        }
    } else {
        parsedProfile = resolveExternalThemeProfileImportProfile(parsed, options);
        if (!parsedProfile) {
            return { ok: false, error: 'unsupportedSchema' };
        }
    }

    if ((options.existingProfileIds?.size ?? 0) >= THEME_PROFILE_MAX_PROFILES) {
        return { ok: false, error: 'invalidProfile' };
    }

    const warnings: ThemeProfileImportWarning[] = [];
    const profile = sanitizeProfile(parsedProfile, options, warnings, {
        defaultBlankName: true,
        rejectInvalidColors: true,
        rejectTooManyOverrides: true,
    });
    if (!profile) {
        return { ok: false, error: 'invalidProfile' };
    }

    return {
        ok: true,
        profile,
        warnings,
    };
};

export const sanitizeThemeProfileOverrides = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1['overrides'] => {
    const warnings: ThemeProfileImportWarning[] = [];
    return Object.fromEntries(MODES.map((mode) => [mode, sanitizeOverrides(overrides[mode], mode, warnings).overrides])) as ThemeProfileV1['overrides'];
};

export const sanitizeThemeProfileOverridesForV1TrustBoundary = (
    overrides: Readonly<Record<ThemeProfileMode, unknown>>,
): ThemeProfileV1['overrides'] | null => {
    const warnings: ThemeProfileImportWarning[] = [];
    const sanitized = Object.fromEntries(MODES.map((mode) => {
        const result = sanitizeOverrides(overrides[mode], mode, warnings, {
            rejectInvalidColors: true,
            rejectTooManyOverrides: true,
        });
        return [mode, result];
    })) as Record<ThemeProfileMode, SanitizeOverridesResult>;

    if (MODES.some((mode) => sanitized[mode].invalid)) {
        return null;
    }

    return Object.fromEntries(MODES.map((mode) => [mode, sanitized[mode].overrides])) as ThemeProfileV1['overrides'];
};
