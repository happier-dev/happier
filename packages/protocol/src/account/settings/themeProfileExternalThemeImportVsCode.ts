import { z } from '../../zodRuntimePolicy.js';
import { parseThemeColorValue, themeRelativeLuminance } from './themeColor.js';
import type { ThemeProfileV1 } from './themeProfiles.js';
import { isValidThemeProfileColorValue } from './themeProfileColors.js';

type ThemeProfileMode = keyof ThemeProfileV1['overrides'];
export const DEFAULT_IMPORTED_THEME_PROFILE_NAME = 'Imported theme';
export type ThemeProfileExternalImportOptions = Readonly<{
    now: string;
    existingProfileIds?: ReadonlySet<string>;
    generateId?: () => string;
}>;
export type ThemeProfileExternalImportAdapter = Readonly<{
    id: string;
    label: string;
    description: string;
    detect: (value: unknown) => number;
    parse: (value: Record<string, unknown>, options: ThemeProfileExternalImportOptions) => ThemeProfileV1 | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isString = (value: unknown): value is string => typeof value === 'string';

const normalizeThemeMode = (value: unknown): ThemeProfileMode | null => {
    if (!isString(value)) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized.includes('light')) return 'light';
    if (normalized.includes('dark')) return 'dark';
    return null;
};

const getColorLuminance = (value: string): number | null => {
    // Transparent has no canvas to infer from; alpha on numeric colors retains the existing mode policy.
    if (value.trim() === 'transparent') return null;
    const color = parseThemeColorValue(value);
    return color ? themeRelativeLuminance(color.rgb) : null;
};

const inferThemeModeFromColor = (value: string): ThemeProfileMode | null => {
    const luminance = getColorLuminance(value);
    if (luminance === null) return null;
    return luminance >= 0.5 ? 'light' : 'dark';
};

const pickColorValue = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
    for (const key of keys) {
        const value = record[key];
        if (isString(value) && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
};

export const pickThemeMode = (theme: Record<string, unknown>): ThemeProfileMode => {
    const explicitMode = normalizeThemeMode(theme.type);
    if (explicitMode) return explicitMode;

    const candidateColors = [
        theme.colors,
        theme.workbenchColorCustomizations,
    ].filter((value): value is Record<string, unknown> => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
    ));

    for (const colors of candidateColors) {
        const inferred = inferThemeModeFromColor(pickColorValue(colors, [
            'editor.background',
            'sideBar.background',
            'activityBar.background',
            'panel.background',
            'titleBar.activeBackground',
        ]) ?? '');
        if (inferred) return inferred;
    }

    return 'dark';
};

const pickString = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
    for (const key of keys) {
        const value = record[key];
        if (isString(value) && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
};

const createEmptyOverrides = (): Record<string, string> => ({});

const setOverride = (
    overrides: Record<string, string>,
    tokenId: string,
    value: string | undefined,
): void => {
    if (!isString(value) || !isValidThemeProfileColorValue(value)) return;
    overrides[tokenId] = value.trim();
};

const mapTokenColorScopeToSyntaxToken = (scope: string): string | null => {
    const normalized = scope.toLowerCase();
    if (normalized.includes('comment')) return 'syntax.comment';
    if (normalized.includes('string')) return 'syntax.string';
    if (normalized.includes('number') || normalized.includes('numeric')) return 'syntax.number';
    if (
        normalized.includes('function')
        || normalized.includes('meta.method')
        || normalized.includes('entity.name.function')
        || normalized.includes('support.function')
        || normalized.includes('method')
    ) {
        return 'syntax.function';
    }
    if (
        normalized.includes('keyword')
        || normalized.includes('storage.type')
        || normalized.includes('storage.modifier')
        || normalized.includes('entity.name.type')
        || normalized.includes('type')
        || normalized.includes('class')
        || normalized.includes('interface')
        || normalized.includes('enum')
        || normalized.includes('decorator')
        || normalized.includes('operator')
    ) {
        return 'syntax.keyword';
    }
    if (normalized.includes('constant.language') || normalized.includes('variable.language')) {
        return 'syntax.keyword';
    }
    return null;
};

const assignTokenColors = (tokenColors: unknown, overrides: Record<string, string>): void => {
    if (!Array.isArray(tokenColors)) return;

    for (const entry of tokenColors) {
        if (!isRecord(entry) || !isRecord(entry.settings)) continue;
        const color = pickString(entry.settings, ['foreground']);
        if (!color) continue;

        const scopes = Array.isArray(entry.scope)
            ? entry.scope.filter(isString)
            : isString(entry.scope)
                ? [entry.scope]
                : [];

        const syntaxToken = scopes.map(mapTokenColorScopeToSyntaxToken).find((tokenId): tokenId is string => tokenId !== null);
        if (syntaxToken) {
            setOverride(overrides, syntaxToken, color);
        }
    }
};

const assignSemanticTokenColors = (semanticTokenColors: unknown, overrides: Record<string, string>): void => {
    if (!isRecord(semanticTokenColors)) return;

    for (const [key, value] of Object.entries(semanticTokenColors)) {
        const color = isString(value) ? value : isRecord(value) ? pickString(value, ['foreground']) : undefined;
        if (!color) continue;

        const normalized = key.toLowerCase();
        if (
            normalized.includes('comment')
            || normalized.includes('string')
            || normalized.includes('regexp')
        ) {
            setOverride(overrides, normalized.includes('comment') ? 'syntax.comment' : 'syntax.string', color);
            continue;
        }
        if (normalized.includes('number')) {
            setOverride(overrides, 'syntax.number', color);
            continue;
        }
        if (
            normalized.includes('function')
            || normalized.includes('method')
            || normalized.includes('constructor')
        ) {
            setOverride(overrides, 'syntax.function', color);
            continue;
        }
        if (
            normalized.includes('keyword')
            || normalized.includes('type')
            || normalized.includes('class')
            || normalized.includes('interface')
            || normalized.includes('enum')
            || normalized.includes('namespace')
            || normalized.includes('decorator')
            || normalized.includes('operator')
        ) {
            setOverride(overrides, 'syntax.keyword', color);
        }
    }
};

const buildExternalThemeOverlays = (mode: ThemeProfileMode): Readonly<{
    pressedOverlay: string;
    sectionTint: string;
    ripple: string;
}> => (
    mode === 'dark'
        ? {
            pressedOverlay: 'rgba(255,255,255,0.06)',
            sectionTint: 'rgba(255,255,255,0.014)',
            ripple: 'rgba(255,255,255,0.10)',
        }
        : {
            pressedOverlay: 'rgba(0,0,0,0.06)',
            sectionTint: 'rgba(0,0,0,0.012)',
            ripple: 'rgba(0,0,0,0.10)',
        }
);

const buildThemeProfileOverridesFromVsCodeTheme = (theme: Record<string, unknown>, mode: ThemeProfileMode): ThemeProfileV1['overrides'] => {
    const colors = isRecord(theme.colors) ? theme.colors : {};
    const overlay = buildExternalThemeOverlays(mode);
    const textPrimary = pickString(colors, ['foreground', 'editor.foreground']) ?? (mode === 'dark' ? '#E0DEF4' : '#1F2328');
    const textSecondary = pickString(colors, ['descriptionForeground', 'sideBar.foreground', 'editorLineNumber.foreground', 'icon.foreground']) ?? (mode === 'dark' ? '#908CAA' : '#656D76');
    const textTertiary = pickString(colors, ['disabledForeground', 'editorLineNumber.dimmedForeground']) ?? (mode === 'dark' ? '#6E6A86' : '#8C959F');
    const surfaceCanvas = pickString(colors, ['editor.background', 'sideBar.background', 'activityBar.background', 'panel.background']) ?? (mode === 'dark' ? '#191724' : '#FFFFFF');
    const surfaceBase = pickString(colors, ['sideBar.background', 'editorPane.background', 'panel.background', 'activityBar.background', 'editor.background']) ?? surfaceCanvas;
    const surfaceInset = pickString(colors, ['textCodeBlock.background', 'editor.background', 'editorWidget.background', 'dropdown.background', 'input.background']) ?? surfaceCanvas;
    const surfaceElevated = pickString(colors, ['editorWidget.background', 'quickInput.background', 'tab.activeBackground', 'dropdown.background', 'menu.background']) ?? surfaceBase;
    const selectedFill = pickString(colors, ['list.activeSelectionBackground', 'list.inactiveSelectionBackground', 'selection.background', 'editor.selectionBackground', 'terminal.selectionBackground']);
    const surfaceSelected = selectedFill && parseThemeColorValue(selectedFill)?.alpha !== 0 ? selectedFill : surfaceElevated;
    const surfacePressed = pickString(colors, ['list.hoverBackground', 'button.hoverBackground', 'tab.hoverBackground']) ?? surfaceSelected;
    const borderSurface = pickString(colors, ['widget.border', 'contrastBorder', 'sideBar.border', 'editorGroup.border', 'panel.border', 'input.border', 'menu.border']) ?? (mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)');
    const borderStrong = pickString(colors, ['focusBorder', 'contrastBorder', 'editorWidget.border']) ?? borderSurface;
    const headerBackground = pickString(colors, ['titleBar.activeBackground', 'activityBar.background', 'panel.background']) ?? surfaceBase;
    const headerForeground = pickString(colors, ['titleBar.activeForeground', 'activityBar.foreground', 'foreground']) ?? textPrimary;
    const buttonBackground = pickString(colors, ['button.background', 'toggleSwitch.background']) ?? surfacePressed;
    const buttonForeground = pickString(colors, ['button.foreground']) ?? textPrimary;
    const inputBackground = pickString(colors, ['input.background', 'dropdown.background', 'editorWidget.background']) ?? surfaceInset;
    const inputForeground = pickString(colors, ['input.foreground', 'foreground']) ?? textPrimary;
    const inputPlaceholder = pickString(colors, ['input.placeholderForeground']) ?? textTertiary;
    const activeForeground = pickString(colors, ['textLink.foreground', 'focusBorder', 'checkbox.selectBorder']) ?? (mode === 'dark' ? '#C4A7E7' : '#0969DA');
    const successForeground = pickString(colors, ['gitDecoration.addedResourceForeground', 'testing.iconPassed', 'charts.green']) ?? (mode === 'dark' ? '#9CCFD8' : '#1F883D');
    const warningForeground = pickString(colors, ['notificationsWarningIcon.foreground', 'editorWarning.foreground', 'gitDecoration.modifiedResourceForeground']) ?? (mode === 'dark' ? '#F6C177' : '#9A6700');
    const dangerForeground = pickString(colors, ['errorForeground', 'editorError.foreground', 'problemsErrorIcon.foreground']) ?? (mode === 'dark' ? '#EB6F92' : '#CF222E');
    const infoForeground = pickString(colors, ['notificationsInfoIcon.foreground']) ?? activeForeground;

    const overrides = createEmptyOverrides();

    setOverride(overrides, 'background.canvas', surfaceCanvas);
    setOverride(overrides, 'surface.base', surfaceBase);
    setOverride(overrides, 'surface.inset', surfaceInset);
    setOverride(overrides, 'surface.elevated', surfaceElevated);
    setOverride(overrides, 'surface.selected', surfaceSelected);
    setOverride(overrides, 'surface.pressed', surfacePressed);
    setOverride(overrides, 'surface.pressedOverlay', overlay.pressedOverlay);
    setOverride(overrides, 'surface.sectionTint', overlay.sectionTint);
    setOverride(overrides, 'surface.ripple', overlay.ripple);
    setOverride(overrides, 'border.default', borderSurface);
    setOverride(overrides, 'border.surface', borderSurface);
    setOverride(overrides, 'border.strong', borderStrong);
    setOverride(overrides, 'border.modal', borderSurface);
    setOverride(overrides, 'chrome.header.background', headerBackground);
    setOverride(overrides, 'chrome.header.foreground', headerForeground);
    setOverride(overrides, 'text.primary', textPrimary);
    setOverride(overrides, 'text.secondary', textSecondary);
    setOverride(overrides, 'text.tertiary', textTertiary);
    setOverride(overrides, 'text.link', pickString(colors, ['textLink.foreground', 'button.background']) ?? activeForeground);
    setOverride(overrides, 'text.destructive', dangerForeground);
    setOverride(overrides, 'text.placeholder', inputPlaceholder);
    setOverride(overrides, 'text.disabled', textTertiary);
    setOverride(overrides, 'state.success.foreground', successForeground);
    setOverride(overrides, 'state.success.background', pickString(colors, ['terminal.ansiGreen', 'testing.iconPassed']) ?? successForeground);
    setOverride(overrides, 'state.success.border', pickString(colors, ['terminal.ansiGreenBright']) ?? successForeground);
    setOverride(overrides, 'state.warning.foreground', warningForeground);
    setOverride(overrides, 'state.warning.background', pickString(colors, ['terminal.ansiYellow', 'charts.yellow']) ?? warningForeground);
    setOverride(overrides, 'state.warning.border', pickString(colors, ['terminal.ansiYellowBright']) ?? warningForeground);
    setOverride(overrides, 'state.danger.foreground', dangerForeground);
    setOverride(overrides, 'state.danger.background', pickString(colors, ['terminal.ansiRed', 'problemsErrorIcon.foreground']) ?? dangerForeground);
    setOverride(overrides, 'state.danger.border', pickString(colors, ['terminal.ansiRedBright']) ?? dangerForeground);
    setOverride(overrides, 'state.info.foreground', infoForeground);
    setOverride(overrides, 'state.info.background', pickString(colors, ['terminal.ansiBlue', 'charts.blue']) ?? infoForeground);
    setOverride(overrides, 'state.info.border', pickString(colors, ['terminal.ansiBlueBright']) ?? infoForeground);
    setOverride(overrides, 'state.neutral.foreground', textSecondary);
    setOverride(overrides, 'state.neutral.background', surfaceSelected);
    setOverride(overrides, 'state.neutral.border', borderSurface);
    setOverride(overrides, 'state.active.foreground', pickString(colors, ['badge.foreground']) ?? activeForeground);
    setOverride(overrides, 'state.active.background', pickString(colors, ['badge.background']) ?? surfaceSelected);
    setOverride(overrides, 'state.active.border', borderStrong);
    setOverride(overrides, 'control.button.primary.background', buttonBackground);
    setOverride(overrides, 'control.button.primary.foreground', buttonForeground);
    setOverride(overrides, 'control.button.primary.disabled', surfacePressed);
    setOverride(overrides, 'control.button.secondary.background', 'transparent');
    setOverride(overrides, 'control.button.secondary.foreground', buttonForeground);
    setOverride(overrides, 'control.input.background', inputBackground);
    setOverride(overrides, 'control.input.foreground', inputForeground);
    setOverride(overrides, 'control.input.placeholder', inputPlaceholder);
    setOverride(overrides, 'composer.chipTint', inputPlaceholder);
    setOverride(overrides, 'control.switch.track.active', activeForeground);
    setOverride(overrides, 'control.switch.track.inactive', surfacePressed);
    setOverride(overrides, 'control.switch.thumb.active', buttonForeground);
    setOverride(overrides, 'control.switch.thumb.inactive', textSecondary);
    setOverride(overrides, 'control.radio.active', activeForeground);
    setOverride(overrides, 'control.radio.inactive', textTertiary);
    setOverride(overrides, 'control.segmentedControl.trackBackground', surfaceInset);
    setOverride(overrides, 'control.segmentedControl.activeBackground', surfaceSelected);
    setOverride(overrides, 'control.fab.background', buttonBackground);
    setOverride(overrides, 'control.fab.backgroundPressed', surfacePressed);
    setOverride(overrides, 'control.fab.foreground', buttonForeground);
    setOverride(overrides, 'control.permissionButton.allow.background', pickString(colors, ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground']) ?? successForeground);
    setOverride(overrides, 'control.permissionButton.allow.foreground', successForeground);
    setOverride(overrides, 'control.permissionButton.deny.background', pickString(colors, ['terminal.ansiRed', 'problemsErrorIcon.foreground']) ?? dangerForeground);
    setOverride(overrides, 'control.permissionButton.deny.foreground', dangerForeground);
    setOverride(overrides, 'control.permissionButton.allowAll.background', pickString(colors, ['terminal.ansiBlue', 'textLink.foreground']) ?? activeForeground);
    setOverride(overrides, 'control.permissionButton.allowAll.foreground', activeForeground);
    setOverride(overrides, 'control.permissionButton.inactive.background', surfaceInset);
    setOverride(overrides, 'control.permissionButton.inactive.border', borderSurface);
    setOverride(overrides, 'control.permissionButton.inactive.foreground', textSecondary);
    setOverride(overrides, 'control.permissionButton.selected.background', surfaceSelected);
    setOverride(overrides, 'control.permissionButton.selected.border', borderStrong);
    setOverride(overrides, 'control.permissionButton.selected.foreground', buttonForeground);
    // A prompt is the theme's neutral raised surface in its body ink; the accent button stays a button.
    setOverride(overrides, 'message.user.background', surfaceElevated);
    setOverride(overrides, 'message.user.foreground', textPrimary);
    setOverride(overrides, 'message.agent.foreground', textPrimary);
    setOverride(overrides, 'message.event.foreground', textSecondary);
    setOverride(overrides, 'syntax.default', textPrimary);
    setOverride(overrides, 'versionControl.added.foreground', successForeground);
    setOverride(overrides, 'versionControl.removed.foreground', dangerForeground);
    setOverride(overrides, 'versionControl.added.background', pickString(colors, ['gitDecoration.addedResourceForeground']) ?? successForeground);
    setOverride(overrides, 'versionControl.removed.background', pickString(colors, ['gitDecoration.deletedResourceForeground']) ?? dangerForeground);
    setOverride(overrides, 'diff.added.background', pickString(colors, ['diffEditor.insertedTextBackground']) ?? successForeground);
    setOverride(overrides, 'diff.added.foreground', successForeground);
    setOverride(overrides, 'diff.removed.background', pickString(colors, ['diffEditor.removedTextBackground']) ?? dangerForeground);
    setOverride(overrides, 'diff.removed.foreground', dangerForeground);
    setOverride(overrides, 'diff.hunk.background', pickString(colors, ['diffEditor.unchangedRegionBackground']) ?? surfaceElevated);
    setOverride(overrides, 'diff.hunk.foreground', activeForeground);
    setOverride(overrides, 'diff.context.foreground', textSecondary);
    setOverride(overrides, 'diff.inlineAdded.background', successForeground);
    setOverride(overrides, 'diff.inlineAdded.foreground', successForeground);
    setOverride(overrides, 'diff.inlineRemoved.background', dangerForeground);
    setOverride(overrides, 'diff.inlineRemoved.foreground', dangerForeground);
    setOverride(overrides, 'permission.default', textSecondary);
    setOverride(overrides, 'permission.acceptEdits', successForeground);
    setOverride(overrides, 'permission.bypass', dangerForeground);
    setOverride(overrides, 'permission.plan', activeForeground);
    setOverride(overrides, 'permission.readOnly', activeForeground);
    setOverride(overrides, 'permission.safeYolo', warningForeground);
    setOverride(overrides, 'permission.yolo', dangerForeground);
    setOverride(overrides, 'overlay.scrimSoft', mode === 'dark' ? 'rgba(25,23,36,0.55)' : 'rgba(0,0,0,0.20)');
    setOverride(overrides, 'overlay.scrim', mode === 'dark' ? 'rgba(25,23,36,0.74)' : 'rgba(0,0,0,0.34)');
    setOverride(overrides, 'overlay.scrimStrong', mode === 'dark' ? 'rgba(25,23,36,0.88)' : 'rgba(0,0,0,0.50)');
    setOverride(overrides, 'overlay.scrimWizard', mode === 'dark' ? 'rgba(25,23,36,0.80)' : 'rgba(0,0,0,0.42)');
    setOverride(overrides, 'overlay.foreground', textPrimary);
    setOverride(overrides, 'overlay.secondaryForeground', textSecondary);

    setOverride(overrides, 'find.matchCurrent', pickString(colors, ['editor.findMatchBackground']));
    setOverride(overrides, 'find.matchCurrentForeground', pickString(colors, ['editor.findMatchForeground']));
    setOverride(overrides, 'find.matchAll', pickString(colors, ['editor.findMatchHighlightBackground']));
    setOverride(overrides, 'find.overviewMark', pickString(colors, ['editorOverviewRuler.findMatchForeground']));

    assignTokenColors(theme.tokenColors, overrides);
    assignSemanticTokenColors(theme.semanticTokenColors, overrides);

    return mode === 'dark'
        ? { light: {}, dark: overrides }
        : { light: overrides, dark: {} };
};

export const VS_CODE_THEME_IMPORT_ADAPTER: ThemeProfileExternalImportAdapter = {
    id: 'vscode-theme-json',
    label: 'VS Code theme JSON',
    description: 'Workbench color themes and TextMate tokenColors exported by VS Code.',
    detect: (value) => {
        if (!isRecord(value)) return 0;
        let score = 0;
        let hasThemePayload = false;
        if (isRecord(value.colors)) {
            score += 4;
            hasThemePayload = true;
        }
        if (Array.isArray(value.tokenColors)) {
            score += 4;
            hasThemePayload = true;
        }
        if (isRecord(value.semanticTokenColors)) {
            score += 2;
            hasThemePayload = true;
        }
        if (!hasThemePayload) return 0;
        if (isString(value.name) && value.name.trim().length > 0) score += 1;
        if (normalizeThemeMode(value.type)) score += 2;
        return score;
    },
    parse: (value, options) => {
        const mode = pickThemeMode(value);
        const name = isString(value.name) && value.name.trim().length > 0 ? value.name.trim() : DEFAULT_IMPORTED_THEME_PROFILE_NAME;
        const overrides = buildThemeProfileOverridesFromVsCodeTheme(value, mode);

        return {
            schemaVersion: 1,
            id: typeof value.id === 'string' && value.id.trim().length > 0 ? value.id.trim() : name,
            name,
            createdAt: options.now,
            updatedAt: options.now,
            base: { light: 'light', dark: 'dark' },
            assetAppearance: mode,
            overrides,
        };
    },
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

const stripJsonTrailingCommas = (text: string): string => {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            output += character;
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        if (character === ',') {
            let next = index + 1;
            while (/\s/.test(text[next] ?? '') && next < text.length) next += 1;
            if (text[next] === '}' || text[next] === ']') continue;
        }
        output += character;
    }
    return output;
};

export const parseThemeImportJsonLikeText = (json: string): unknown | null => {
    try {
        return JSON.parse(json);
    } catch {
        try {
            return JSON.parse(stripJsonTrailingCommas(stripJsonComments(json)));
        } catch {
            return null;
        }
    }
};

export type ThemeImportResource = Readonly<{ id: string; text: string }>;
export type ThemeImportResourceReader = (
    relativePath: string, fromResourceId: string, signal?: AbortSignal,
) => Promise<ThemeImportResource>;
export const ThemeImportIssueCodeSchema = z.enum(['include_unavailable', 'include_cycle', 'invalid_theme']);
export type ThemeImportIssueCode = z.infer<typeof ThemeImportIssueCodeSchema>;

export class ThemeImportIssueError extends Error {
    readonly name = 'ThemeImportIssueError';
    constructor(
        readonly code: ThemeImportIssueCode,
        readonly resourceId: string,
        readonly relativePath?: string,
        options?: ErrorOptions,
    ) {
        super(`${code}: ${relativePath ?? resourceId}`, options);
    }
}

/** Resolves one import locally; the resource reader owns path containment and acquisition. */
export async function resolveVsCodeThemeIncludes(input: Readonly<{
    root: ThemeImportResource; read: ThemeImportResourceReader; signal?: AbortSignal;
}>): Promise<Readonly<Record<string, unknown>>> {
    const ancestors = new Set<string>();
    const themes: Record<string, unknown>[] = [];
    let resource = input.root;
    while (true) {
        input.signal?.throwIfAborted();
        ancestors.add(resource.id);
        const theme = parseThemeImportJsonLikeText(resource.text);
        if (!isRecord(theme)) throw new ThemeImportIssueError('invalid_theme', resource.id);
        themes.push(theme);
        if (theme.include === undefined) break;
        if (!isString(theme.include) || theme.include.trim().length === 0) {
            throw new ThemeImportIssueError('invalid_theme', resource.id);
        }
        const relativePath = theme.include;
        let parent: ThemeImportResource;
        try {
            parent = await input.read(relativePath, resource.id, input.signal);
        } catch (cause) {
            input.signal?.throwIfAborted();
            throw new ThemeImportIssueError('include_unavailable', resource.id, relativePath, { cause });
        }
        input.signal?.throwIfAborted();
        if (ancestors.has(parent.id)) {
            throw new ThemeImportIssueError('include_cycle', parent.id, relativePath);
        }
        resource = parent;
    }
    input.signal?.throwIfAborted();
    // A VS Code theme has one parent. Walking once and merging once keeps valid
    // chains linear without a depth budget or repeatedly copying inherited maps.
    themes.reverse();
    const resolved: Record<string, unknown> = Object.fromEntries(themes.flatMap(theme => Object.entries(theme)));
    for (const key of ['colors', 'semanticTokenColors'] as const) {
        const maps = themes.map(theme => theme[key]).filter(isRecord);
        if (maps.length > 0) resolved[key] = Object.fromEntries(maps.flatMap(map => Object.entries(map)));
    }
    delete resolved.include;
    return resolved;
}
