import type { SurfaceAddress, SurfaceId, SurfacePart, ThemeSurfaceState } from '@happier-dev/plugin-ui';
import type { TextStyle, ViewStyle } from 'react-native';
import type {
    ThemeCssRange as WireThemeCssRange,
    ThemeCssRuleCoverage as WireThemeCssRuleCoverage,
    ThemeCssCoverage as WireThemeCssCoverage,
    ThemeCssDetailedCoverage as WireThemeCssDetailedCoverage,
} from '@happier-dev/protocol/actions';

export type ThemeCssRange = WireThemeCssRange;
export type ThemeCssRuleCoverage = WireThemeCssRuleCoverage;
export type ThemeCssCoverage = WireThemeCssCoverage<SurfaceAddress>;
/** Detailed authored ranges are requested by get/editor, never echoed in operation results. */
export type ThemeCssDetailedCoverage = WireThemeCssDetailedCoverage<SurfaceAddress>;
export type ThemeSurfaceStyleTable = Readonly<{
    [S in SurfaceId]?: Readonly<{
        [P in SurfacePart<S>]?: Readonly<{
            base: Readonly<ViewStyle & TextStyle>;
            states: Partial<Readonly<Record<ThemeSurfaceState<S>, Readonly<ViewStyle & TextStyle>>>>;
        }>;
    }>;
}>;
export type PreparedThemeCss = Readonly<{
    source: string;
    /** Lazy projections on web; the runtime sheet path reads source only. */
    light: ThemeSurfaceStyleTable;
    dark: ThemeSurfaceStyleTable;
    coverage: ThemeCssCoverage;
    /** Requested by get/editor; operation results consume the compact coverage above. */
    detailedCoverage: ThemeCssDetailedCoverage;
}>;
export type { ThemeStylesheetResult } from './themeStylesheet';
