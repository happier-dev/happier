export type ThemeStylesheetInput = Readonly<{ source: string }>;
export type ThemeStylesheetResult = Readonly<{
    available: boolean;
    /** Completed sanitizer output for the existing hosted-document theme channel. */
    sanitizedCss?: string;
    stripped: readonly Readonly<{ reason: string; rule: string; property?: string }>[];
    error?: string;
}>;

/** Native applies compiled surface styles; CSS text is never attached there. */
export function applyThemeStylesheet(_prepared: ThemeStylesheetInput | null, _mode: 'light' | 'dark'): ThemeStylesheetResult {
    return { available: false, stripped: [], error: 'Native uses compiled surface styles' };
}

export const getThemeStylesheetCss = (): null => null;
export const subscribeThemeStylesheet = (_listener: () => void): (() => void) => () => {};
