import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import { createPluginSurfaceContext } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';

/**
 * A public `SurfaceContext` built through the REAL context and theme owners, so
 * a test never hand-writes the snapshot shape its neighbour produces (§7 layer
 * 3). Override only the facts the test is about.
 */
export function createPluginSurfaceContextFixture(
    overrides: Partial<SurfaceContext> = {},
): SurfaceContext {
    const base = createPluginSurfaceContext({
        mount: {
            kind: 'destination',
            destination: { pluginId: 'com.acme.fixture', localId: 'surface' },
            container: 'detailsTab',
        },
        target: { kind: 'session', sessionId: 'session-1' },
        accountEncryptionMode: 'e2ee',
        environment: {
            platform: 'web',
            locale: 'en',
            direction: 'ltr',
            colorScheme: 'light',
            contrast: 'normal',
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            theme: projectPluginUiTheme(lightTheme),
        },
        translations: {},
        targetedContributions: {
            target: {
                pluginId: 'com.acme.fixture',
                immutableGenerationId: 'target-generation-a',
            },
            points: [],
        },
    });
    return Object.freeze({ ...base, ...overrides });
}
