import { EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS } from '../tokens/themeColorTokenDefinitions';
import { getBaseTheme } from './baseThemeCatalog';
import { readThemeProfilePathValue, type ThemeProfilePath } from './themeProfilePathAccess';
import type { ThemeProfileMode, ThemeProfilePublicTokenId } from './themeProfileTypes';

export type ThemeProfileTokenValueKind = 'color';
export type ThemeProfileTokenStatus = 'publicEditable' | 'internalOnly' | 'derived' | 'deprecated';

export type ThemeProfileContrastPair = Readonly<{
    tokenId: ThemeProfilePublicTokenId;
    minRatio: number;
}>;

export type ThemeProfileTokenDefinition = Readonly<{
    id: ThemeProfilePublicTokenId;
    path: ThemeProfilePath;
    group: string;
    label: string;
    description: string;
    editable: true;
    exportable: true;
    valueKind: ThemeProfileTokenValueKind;
    status: 'publicEditable';
    contrastPairs?: readonly ThemeProfileContrastPair[];
}>;

export const THEME_PROFILE_TOKEN_DEFINITIONS: readonly ThemeProfileTokenDefinition[] = EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => ({
    id: definition.id,
    path: definition.path,
    group: definition.group,
    label: definition.label,
    description: definition.description,
    editable: true,
    exportable: true,
    valueKind: definition.valueKind,
    status: 'publicEditable',
    ...('contrastPairs' in definition ? { contrastPairs: definition.contrastPairs } : {}),
}));

export const THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID: Readonly<Record<string, ThemeProfileTokenDefinition>> = Object.freeze(
    Object.fromEntries(THEME_PROFILE_TOKEN_DEFINITIONS.map((definition) => [definition.id, definition])),
);

export const THEME_PROFILE_PUBLIC_TOKEN_IDS = THEME_PROFILE_TOKEN_DEFINITIONS.map((definition) => definition.id);

export const getThemeProfileTokenDefinition = (tokenId: string): ThemeProfileTokenDefinition | undefined => THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID[tokenId];

export const isThemeProfilePublicTokenId = (tokenId: string): tokenId is ThemeProfilePublicTokenId => getThemeProfileTokenDefinition(tokenId) !== undefined;

export const readThemeProfileBaseTokenValue = (mode: ThemeProfileMode, tokenId: string): string | undefined => {
    const definition = getThemeProfileTokenDefinition(tokenId);
    if (!definition) return undefined;

    return readThemeProfilePathValue(getBaseTheme(mode).colors, definition.path);
};
