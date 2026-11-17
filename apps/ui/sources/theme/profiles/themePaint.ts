import { getEditableThemeColorTokenDefinition, type ThemeColorTokenId } from '../tokens/themeColorTokenDefinitions';
import { readThemeProfilePathValue } from './themeProfilePathAccess';
import type { ThemeSurfacePaintSource, ThemeSurfacePaintRole } from '@happier-dev/plugin-sdk/ui';

export type ThemePaint = Readonly<{ color: string; source: ThemeSurfacePaintSource }>;
export type ThemePaintFacets = Readonly<Partial<Record<ThemeSurfacePaintRole['facet'], ThemePaint>>>;

/** The editable-token owner supplies both its public id and its real color path. */
export function tokenThemePaint(theme: Readonly<{ colors: unknown }>, id: ThemeColorTokenId): ThemePaint {
    const definition = getEditableThemeColorTokenDefinition(id)!;
    return { color: readThemeProfilePathValue(theme.colors, definition.path)!, source: { kind: 'token', ref: definition.id } };
}

export function fixedThemePaint(color: string): ThemePaint {
    return { color, source: { kind: 'fixed' } };
}

/** Calculations consume the same paired inputs that supply their editable references. */
export function deriveThemePaint<const Inputs extends readonly ThemePaint[]>(inputs: Inputs,
    calculate: (...colors: { [Key in keyof Inputs]: string }) => string): ThemePaint {
    const color = calculate(...inputs.map(input => input.color) as { [Key in keyof Inputs]: string });
    const from = [...new Set(inputs.flatMap(input => input.source.kind === 'token' ? [input.source.ref]
        : input.source.kind === 'derived' ? input.source.from : []))];
    const [first, ...rest] = from;
    return first === undefined ? fixedThemePaint(color) : { color, source: { kind: 'derived', from: [first, ...rest] } };
}
