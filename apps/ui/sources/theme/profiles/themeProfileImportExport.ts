import { parseThemeImportJsonLikeText, resolveVsCodeThemeIncludes, ThemeImportIssueError, type ThemeImportIssueCode, type ThemeImportResourceReader } from '@happier-dev/protocol/account/settings/themeProfileExternalThemeImportVsCode';
import { createThemeProfileFile, ThemeProfileFileEnvelopeSchema } from '@happier-dev/protocol/account/settings/themeProfileFile';
import { ThemeProfileIdSchema, ThemeProfileNameSchema, isReservedThemeProfileId, migrateThemeProfileOverrideTokenId, migrateThemeProfileOverrideTokenIds } from '@happier-dev/protocol/account/settings/themeProfiles';
import {
    DEFAULT_IMPORTED_THEME_PROFILE_NAME,
    THEME_PROFILE_SCHEMA_VERSION,
} from './themeProfileConstants';
import { isValidThemeProfileColorValue } from './themeProfileColorValidation';
import { getThemeProfileTokenDefinition, THEME_PROFILE_TOKEN_DEFINITIONS } from './themeProfileTokenRegistry';
import { resolveThemeProfile } from './resolveThemeProfile';
import { readThemeProfilePathValue } from './themeProfilePathAccess';
import { inferThemeProfileAssetAppearance, isThemeProfileAssetAppearance } from './themeProfileAssetAppearance';
import { resolveExternalThemeProfileImportProfile } from './themeProfileExternalThemeImport';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { randomUUID } from '@/platform/randomUUID';
import type { ThemeProfileDocument, ThemeProfileColorOverrides, ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

export { getSupportedThemeProfileImportFormats } from './themeProfileExternalThemeImport';

export type ThemeProfileImportWarning =
    | Readonly<{ code: 'unknownToken'; tokenId: string; mode: ThemeProfileMode }>
    | Readonly<{ code: 'invalidColor'; tokenId: string; mode: ThemeProfileMode }>
    | Readonly<{ code: 'migratedToken'; tokenId: string; migratedTokenId: string; mode: ThemeProfileMode }>;

export type ThemeProfileImportResult =
    | Readonly<{ ok: true; profile: ThemeProfileV1; document: ThemeProfileDocument; warnings: readonly ThemeProfileImportWarning[] }>
    | Readonly<{ ok: false; error: 'invalidJson' | 'unsupportedSchema' | 'invalidProfile' }>
    | Readonly<{ ok: false; error: ThemeImportIssueCode; resourceId: string; relativePath?: string }>;

type ImportOptions = Readonly<{
    now: string;
    generateId?: () => string;
    resource?: Readonly<{ id: string; read: ThemeImportResourceReader }>;
}>;

type ExportThemeProfileOptions = Readonly<{
    mode?: ThemeProfileMode;
    includeResolvedValues?: boolean;
}>;


const MODES = ['light', 'dark'] as const satisfies readonly ThemeProfileMode[];

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stableStringify = (value: unknown): string => JSON.stringify(value, null, 2);

export { migrateThemeProfileOverrideTokenIds } from '@happier-dev/protocol/account/settings/themeProfiles';

type SanitizeOverridesOptions = Readonly<{
    defaultBlankName?: boolean;
    rejectInvalidColors?: boolean;
}>;

type SanitizeOverridesResult = Readonly<{
    overrides: ThemeProfileColorOverrides;
    invalid: boolean;
}>;

export const sanitizeThemeProfileName = (name: unknown, options: SanitizeOverridesOptions = {}): string | null => {
    if (typeof name === 'string' && name.trim().length === 0 && !/[\u0000-\u001F\u007F]/.test(name)) {
        return options.defaultBlankName === true ? DEFAULT_IMPORTED_THEME_PROFILE_NAME : null;
    }
    const parsed = ThemeProfileNameSchema.safeParse(name);
    return parsed.success ? parsed.data : null;
};

export const isRouteSafeThemeProfileId = (id: string): boolean => {
    const parsed = ThemeProfileIdSchema.safeParse(id);
    return parsed.success && parsed.data === id;
};

export { isReservedThemeProfileId } from '@happier-dev/protocol/account/settings/themeProfiles';

export const createThemeProfileId = (): string => randomUUID();

const sanitizeId = (id: unknown): string => {
    const sourceId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : createThemeProfileId();
    if (
        isRouteSafeThemeProfileId(sourceId)
        && !isReservedThemeProfileId(sourceId)
    ) {
        return sourceId;
    }

    return createThemeProfileId();
};

const sanitizeOverrides = (
    sourceOverrides: unknown,
    mode: ThemeProfileMode,
    warnings: ThemeProfileImportWarning[],
    options: SanitizeOverridesOptions = {},
): SanitizeOverridesResult => {
    if (!isRecord(sourceOverrides)) return { overrides: {}, invalid: false };

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
): ThemeProfileV1 | null => {
    const name = sanitizeThemeProfileName(profile.name);
    if (!name) return null;

    const light = sanitizeOverrides(profile.overrides?.light, 'light', warnings);
    const dark = sanitizeOverrides(profile.overrides?.dark, 'dark', warnings);

    const sanitizedProfileWithoutAssetAppearance = {
        ...profile,
        schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
        id: sanitizeId(profile.id),
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

export const exportThemeProfileToJson = (input: ThemeProfileV1 | ThemeProfileDocument, options: ExportThemeProfileOptions = {}): string => {
    if ('raw' in input) {
        if (!options.includeResolvedValues || !options.mode) return stableStringify(createThemeProfileFile(input.raw));
        const mode = options.mode;
        const overrides = isRecord(input.raw.overrides) ? input.raw.overrides : {};
        const authored = isRecord(overrides[mode]) ? overrides[mode] : {};
        return stableStringify(createThemeProfileFile({
            ...input.raw,
            overrides: { ...overrides, [mode]: { ...resolveCompleteModeOverrides(input.profile, mode), ...authored } },
        }));
    }
    const profile = input;
    const warnings: ThemeProfileImportWarning[] = [];
    const sanitizedProfile = sanitizeProfile(resolveExportProfile(profile, options), { now: profile.updatedAt }, warnings);
    if (!sanitizedProfile) {
        throw new Error('Cannot export an invalid theme profile.');
    }

    return stableStringify(createThemeProfileFile(sanitizedProfile));
};

export const importThemeProfileFromJson = (json: string, options: ImportOptions): ThemeProfileImportResult | Promise<ThemeProfileImportResult> => {
    const parsed = parseThemeImportJsonLikeText(json);
    if (parsed === null) {
        return { ok: false, error: 'invalidJson' };
    }

    // Files create editable copies; their record identity belongs to the exporting Account.
    const copyId = (options.generateId ?? createThemeProfileId)();
    const nativeFile = ThemeProfileFileEnvelopeSchema.safeParse(parsed);
    const completeImport = (resolved: unknown): ThemeProfileImportResult => {
        let rawProfile: unknown;
        if (nativeFile.success) {
            rawProfile = nativeFile.data.profile;
        } else {
            rawProfile = resolveExternalThemeProfileImportProfile(resolved, { ...options, generateId: () => copyId });
            if (!rawProfile) {
                return { ok: false, error: 'unsupportedSchema' };
            }
        }

        if (!isRecord(rawProfile)) return { ok: false, error: 'invalidProfile' };
        const name = sanitizeThemeProfileName(rawProfile.name, { defaultBlankName: true });
        if (!name) return { ok: false, error: 'invalidProfile' };
        const read = parseThemeProfileDocument({ ...rawProfile,
            id: copyId, name,
            createdAt: typeof rawProfile.createdAt === 'string' ? rawProfile.createdAt : options.now,
            updatedAt: typeof rawProfile.updatedAt === 'string' ? rawProfile.updatedAt : options.now,
        });
        if (!read.ok) return { ok: false, error: 'invalidProfile' };
        // Files import editable copies; source-owned records are admitted by their installer.
        const document = read.document.profile.source && read.document.profile.source.kind !== 'yours'
            ? mergeThemeProfileDocumentEdit(read.document, { source: { kind: 'yours' } })
            : read.document;
        const warnings: ThemeProfileImportWarning[] = [];
        const projectMode = (mode: ThemeProfileMode): ThemeProfileColorOverrides => {
            const overrides = document.profile.overrides[mode];
            const unknown = Object.keys(overrides).filter(tokenId => !getThemeProfileTokenDefinition(tokenId));
            if (!unknown.length) return overrides;
            const supported = { ...overrides };
            for (const tokenId of unknown.sort((left, right) => left.localeCompare(right))) {
                warnings.push({ code: 'unknownToken', tokenId, mode });
                delete supported[tokenId];
            }
            return supported;
        };
        const profile = { ...document.profile, overrides: { light: projectMode('light'), dark: projectMode('dark') } };
        profile.assetAppearance ??= inferThemeProfileAssetAppearance(profile);

        return {
            ok: true,
            profile,
            document,
            warnings,
        };
    };
    if (!nativeFile.success && isRecord(parsed) && parsed.include !== undefined) {
        return resolveVsCodeThemeIncludes({
            root: { id: options.resource?.id ?? 'theme.json', text: json },
            read: options.resource?.read ?? (async () => { throw new Error('No local theme resource reader'); }),
        }).then(completeImport, (error: unknown): ThemeProfileImportResult => {
            if (!(error instanceof ThemeImportIssueError)) throw error;
            return { ok: false, error: error.code, resourceId: error.resourceId,
                ...(error.relativePath === undefined ? {} : { relativePath: error.relativePath }) };
        });
    }
    return completeImport(parsed);
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
        });
        return [mode, result];
    })) as Record<ThemeProfileMode, SanitizeOverridesResult>;

    if (MODES.some((mode) => sanitized[mode].invalid)) {
        return null;
    }

    return Object.fromEntries(MODES.map((mode) => [mode, sanitized[mode].overrides])) as ThemeProfileV1['overrides'];
};
