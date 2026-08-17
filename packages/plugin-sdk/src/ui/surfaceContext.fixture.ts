import type { PluginUiThemeV1, SurfaceContext } from './hostApi.js';

/**
 * Test-only surface fixtures, exported only through the experimental
 * `@happier-dev/plugin-sdk/testing` boundary. They let composed client and
 * external-author tests build the SAME snapshot shape the host projects
 * instead of drifting hand-written literals.
 *
 * The colour values here are deliberately arbitrary sentinels. The real values
 * are projected from Happier's canonical theme tokens by
 * `apps/ui/.../surfaces/pluginUiThemeProjection.ts`, which is where the
 * token-identity contract is tested.
 */
export const SURFACE_CONTEXT_THEME_FIXTURE: PluginUiThemeV1 = {
    version: 1,
    colors: {
        canvas: '#101010',
        surface: '#202020',
        elevatedSurface: '#303030',
        text: '#f0f0f0',
        secondaryText: '#c0c0c0',
        mutedText: '#909090',
        border: '#404040',
        divider: '#353535',
        focus: '#5599ff',
        accent: '#2277ee',
        onAccent: '#ffffff',
        success: '#34c759',
        warning: '#ff9500',
        danger: '#ff3b30',
        info: '#5856d6',
        control: '#252525',
        controlDisabled: '#454545',
        overlay: 'rgba(0, 0, 0, 0.5)',
    },
    spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 20 },
    radii: { small: 4, control: 8, panel: 12, pill: 999 },
    typography: {
        body: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
        label: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
        title: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
        caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
        code: { fontSize: 12, lineHeight: 16, fontFamily: 'IBMPlexMono-Regular' },
    },
};

/**
 * The testkit's default surface models the sole initial Host API context. Its
 * target snapshot is never a materialization or global contributor catalog.
 */
export const SURFACE_CONTEXT_TARGETED_CONTRIBUTIONS_FIXTURE: NonNullable<
    SurfaceContext['targetedContributions']
> = {
    target: {
        pluginId: 'com.acme.fixture',
        immutableGenerationId: 'target-generation-a',
    },
    points: [],
};

export function createSurfaceContextFixture(
    overrides: Partial<SurfaceContext> = {},
): SurfaceContext {
    return {
        mount: {
            kind: 'destination',
            destination: { pluginId: 'com.acme.fixture', localId: 'details' },
            container: 'detailsTab',
        },
        target: { kind: 'session', sessionId: 'session-1', agentId: 'codex' },
        accountEncryptionMode: 'e2ee',
        platform: 'web',
        locale: 'en-GB',
        direction: 'ltr',
        colorScheme: 'dark',
        contrast: 'normal',
        textScale: 1,
        reducedMotion: false,
        screenReaderEnabled: false,
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        theme: SURFACE_CONTEXT_THEME_FIXTURE,
        translations: {},
        targetedContributions: SURFACE_CONTEXT_TARGETED_CONTRIBUTIONS_FIXTURE,
        ...overrides,
    };
}
