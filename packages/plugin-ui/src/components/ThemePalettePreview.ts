import { ThemePalettePreview as SharedThemePalettePreview } from '../presentation/form/ThemePalettePreview.js';

/** Plugin authors pass the same explicit palette as the host; no provider adapter is needed. */
export const ThemePalettePreview = SharedThemePalettePreview;
export type {
  ThemePalettePreviewProps,
  ThemePreviewPalette,
  ThemePreviewPaint,
  ThemeMiniatureForm,
} from '../presentation/form/ThemePalettePreview.js';
