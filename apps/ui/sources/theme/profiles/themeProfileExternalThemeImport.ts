import type { ThemeProfileV1 } from './themeProfileTypes';
import { VS_CODE_THEME_IMPORT_ADAPTER } from './themeProfileExternalThemeImportVsCode';

import type { ThemeProfileExternalImportAdapter, ThemeProfileExternalImportOptions } from '@happier-dev/protocol/account/settings/themeProfileExternalThemeImportVsCode';
export type { ThemeProfileExternalImportAdapter, ThemeProfileExternalImportOptions } from '@happier-dev/protocol/account/settings/themeProfileExternalThemeImportVsCode';

export type ThemeProfileImportFormatSummary = Readonly<{
    id: string;
    label: string;
    description: string;
}>;

const THEME_PROFILE_EXTERNAL_IMPORT_ADAPTERS: readonly ThemeProfileExternalImportAdapter[] = [
    VS_CODE_THEME_IMPORT_ADAPTER,
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const resolveBestExternalThemeImportAdapter = (value: unknown): ThemeProfileExternalImportAdapter | null => {
    let bestAdapter: ThemeProfileExternalImportAdapter | null = null;
    let bestScore = 0;

    for (const adapter of THEME_PROFILE_EXTERNAL_IMPORT_ADAPTERS) {
        const score = adapter.detect(value);
        if (score > bestScore) {
            bestAdapter = adapter;
            bestScore = score;
        }
    }

    return bestAdapter;
};

export const getSupportedThemeProfileImportFormats = (): readonly ThemeProfileImportFormatSummary[] => [
    {
        id: 'happier-theme-profile-json',
        label: 'Happier theme profile JSON',
        description: 'Exported Happier theme profiles and backups.',
    },
    ...THEME_PROFILE_EXTERNAL_IMPORT_ADAPTERS.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        description: adapter.description,
    })),
];

export const resolveExternalThemeProfileImportProfile = (
    value: unknown,
    options: ThemeProfileExternalImportOptions,
): ThemeProfileV1 | null => {
    const adapter = resolveBestExternalThemeImportAdapter(value);
    if (!adapter || !isRecord(value)) return null;
    return adapter.parse(value, options);
};
