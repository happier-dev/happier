import { z } from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    uiFontScale: z.number().describe('In-app UI font scale multiplier (stacks with OS font scale)'),
    uiFontSize: z.enum(['xxsmall', 'xsmall', 'small', 'default', 'large', 'xlarge', 'xxlarge']).optional().describe('Deprecated: legacy in-app UI font size'),
    sidebarCollapsed: z.boolean().describe('Collapse the permanent sidebar on tablets'),
    sidebarWidthPx: z.number().describe('Preferred sidebar width in px'),
    sidebarWidthBasisPx: z.number().describe('Container width basis for sidebar width scaling'),
    uiMultiPanePanelsEnabled: z.boolean().describe('Enable multi-pane right/details panels (web/tablet)'),
    sessionsRightPaneDefaultOpen: z.boolean().describe('Automatically open the right sidebar when entering a session (web/tablet)'),
    detailsPaneTabsBehavior: z.enum(['preview', 'persistent']).describe('Details pane tab behavior: preview (single slot) or persistent'),
    editorFocusModeEnabled: z.boolean().describe('Hide main content + sidebar to focus on right/details panes (web/tablet)'),
    rightPaneWidthPx: z.number().describe('Preferred right pane dock width in px'),
    rightPaneWidthBasisPx: z.number().describe('Container width basis for right pane width scaling'),
    detailsPaneWidthPx: z.number().describe('Preferred details pane dock width in px'),
    detailsPaneWidthBasisPx: z.number().describe('Container width basis for details pane width scaling'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    uiFontScale: 1,
    uiFontSize: 'default',
    sidebarCollapsed: false,
    sidebarWidthPx: 320,
    sidebarWidthBasisPx: 1200,
    uiMultiPanePanelsEnabled: true,
    sessionsRightPaneDefaultOpen: false,
    detailsPaneTabsBehavior: 'preview',
    editorFocusModeEnabled: false,
    rightPaneWidthPx: 360,
    rightPaneWidthBasisPx: 1200,
    detailsPaneWidthPx: 520,
    detailsPaneWidthBasisPx: 1200,
    acknowledgedCliVersions: {},
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }

    const legacyScaleBySize: Record<string, number> = {
        xxsmall: 0.8,
        xsmall: 0.85,
        small: 0.93,
        default: 1,
        large: 1.1,
        xlarge: 1.2,
        xxlarge: 1.3,
    };

    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const UI_FONT_SCALE_MIN = 0.5;
    const UI_FONT_SCALE_MAX = 2.5;

    const data = parsed.data as any;
    const nextUiFontScaleRaw =
        typeof data.uiFontScale === 'number'
            ? data.uiFontScale
            : (typeof data.uiFontSize === 'string' ? legacyScaleBySize[data.uiFontSize] : undefined);

    const nextUiFontScale =
        typeof nextUiFontScaleRaw === 'number' && Number.isFinite(nextUiFontScaleRaw)
            ? clamp(nextUiFontScaleRaw, UI_FONT_SCALE_MIN, UI_FONT_SCALE_MAX)
            : localSettingsDefaults.uiFontScale;

    return { ...localSettingsDefaults, ...parsed.data, uiFontScale: nextUiFontScale };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
