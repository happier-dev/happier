import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { findTestInstanceByTypeWithProps, flattenTestStyle, renderScreen as renderPanelScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


let initialTabId = 'git';
const materialPlatform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() { return materialPlatform.os; },
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                    options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => 'en',
        });
    },
});



// Native safe-area measurements are the platform boundary; chrome merging stays real.
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 17, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));






function getStyleValue(node: renderer.ReactTestInstance, key: string): unknown {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}


// Install platform options before the real runtime graph resolves React Native.
const { installSessionPaneRuntimeTestHarness } = await import('./sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
async function renderScreen(element: React.ReactElement) {
    const screen = await renderPanelScreen(<runtime.Wrapper>{element}</runtime.Wrapper>);
    await act(async () => runtime.pane.openRight({ tabId: initialTabId }));
    return screen;
}

describe('SessionRightPanel (mobile screen chrome)', () => {
    it.each(['cleared', 'reading'] as const)('inherits the shell content material (%s) instead of hiding the wallpaper behind its shared tab frame', async (coat) => {
        // Android supplies the real tint tier in this host; iOS chrome cases below retain their existing boundary.
        materialPlatform.os = 'android';
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const onPicture = (content: React.ReactNode) => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
                <GlassSurface plane surfaceGroup="content" atmosphereCoat={coat === 'reading' ? 'reading' : undefined}>{content}</GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;

        const screen = await renderScreen(onPicture(<SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />));
        expect(flattenTestStyle(screen.findHostByTestId('session-right-panel-root')?.props.style).backgroundColor).toBe('transparent');
    });
    beforeEach(() => {
        initialTabId = 'git';
        materialPlatform.os = 'ios';
        vi.clearAllMocks();
    });

    it('omits redundant header controls when the pane has an external action rail', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { PaneActionRailContext } = await import('@/components/appShell/panes/PaneActionRailContext');
        const screen = await renderScreen(
            <PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000 }}>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
            </PaneActionRailContext.Provider>,
        );
        expect(screen.findByTestId('session-rightpanel-close')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:git')).toBeNull();
    });

    it('keeps the active pane header reachable on a screen even inside an action rail', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { PaneActionRailContext } = await import('@/components/appShell/panes/PaneActionRailContext');
        const screen = await renderScreen(
            <PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000 }}>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />
            </PaneActionRailContext.Provider>,
        );
        expect(screen.findHostByTestId('session-rightpanel-header')).not.toBeNull();
    });

    it('renders the screen close affordance as a leading back button on native', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId="s1" scopeId="session:s1" presentation="screen" />,
        );

        const closeButton = screen.findHostByTestId('session-rightpanel-close');
        if (!closeButton) {
            throw new Error('Expected close button to render');
        }
        expect(closeButton.props.accessibilityLabel).toBe('common.back');
        expect(getStyleValue(closeButton, 'borderWidth')).toBeUndefined();
        expect(getStyleValue(closeButton, 'backgroundColor')).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(closeButton, 'Icon', {
            name: 'caret-left',
            size: 24,
        })).toBeTruthy();

        let header = closeButton.parent;
        while (header && getStyleValue(header, 'paddingTop') === undefined) {
            header = header.parent;
        }
        if (!header) {
            throw new Error('Expected close button to be inside the header');
        }
        expect(header.findAll((node) => typeof node.type === 'string' && node.props.testID === 'session-rightpanel-close')[0]).toBe(closeButton);
        expect(header.findAll((node) => typeof node.type === 'string' && node.props.testID?.startsWith('session-rightpanel-tab:')).every((tab) => header!.findAll(() => true).indexOf(closeButton) < header!.findAll(() => true).indexOf(tab))).toBe(true);
    });
});
