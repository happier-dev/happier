import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SessionCockpitSurfaceScreenProps } from './SessionCockpitSurfaceScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCockpitSurfaceScreen } from './SessionCockpitSurfaceScreen';
import { FileErrorState, FileLoadingState } from '@/components/sessions/files/file/FileScreenState';
import { SessionFileDetailsView } from '@/components/sessions/files/views/SessionFileDetailsView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => '/session/s1' }).module);
const focus = vi.hoisted(() => ({ active: true }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => focus.active }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// Node cannot resolve this RN selector's extensionless require; keep the actual web implementation.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => await import('@/components/ui/code/editor/CodeEditor.web'));

const FILE_PATH = '/tmp/issue878/report with spaces.md';

describe('cockpit fullscreen file activity', () => {
    beforeEach(() => {
        standardCleanup();
        focus.active = true;
        resetServerFeaturesClientForTests();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: {} }), {
            headers: { 'content-type': 'application/json' },
        })));
        storage.setState({
            isDataReady: true,
            sessions: { s1: createSessionFixture({ id: 's1', metadata: { path: '/work/repo', host: 'test.local' } }) },
            machines: {},
        });
    });
    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
    });

    async function loadHarness() {

        function FullscreenDetailsHarness(props: Readonly<{ paneOpen?: boolean; safeAreaPadding?: boolean }>) {
            const pane = useAppPaneScope('session:s1');
            const initialized = React.useRef(false);
            React.useEffect(() => {
                if (initialized.current) return;
                initialized.current = true;
                pane.openDetailsTab({ key: `file:${FILE_PATH}`, kind: 'file', title: 'report', resource: { kind: 'file', path: FILE_PATH } });
                if (!props.paneOpen) pane.closeDetails();
            }, [pane, props.paneOpen]);

            // Render the real surface's content slot directly: SessionView owns the surrounding
            // session chrome, while this regression concerns the surface/panel/file loading path.
            const surfaceProps: SessionCockpitSurfaceScreenProps = {
                sessionId: 's1', scopeId: 'session:s1', surface: 'tabs', safeAreaPadding: props.safeAreaPadding,
            };
            // React.memo's first TypeScript overload omits its real runtime `type` field.
            const renderSurface = (SessionCockpitSurfaceScreen as React.MemoExoticComponent<
                (props: SessionCockpitSurfaceScreenProps) => React.ReactElement<{ contentOverride: React.ReactNode }>
            >).type;
            const chrome = renderSurface(surfaceProps);
            return chrome.props.contentOverride;
        }

        return { AppPaneProvider, FullscreenDetailsHarness };
    }

    it.each([undefined, false])('loads a selected fullscreen file with the persisted pane closed (safe area: %s)', async (safeAreaPadding) => {
        const { AppPaneProvider, FullscreenDetailsHarness } = await loadHarness();
        const screen = await renderScreen(<AppPaneProvider><FullscreenDetailsHarness safeAreaPadding={safeAreaPadding} /></AppPaneProvider>);
        await vi.waitFor(() => {
            // No machine is paired in this fixture, so the real file operation must settle in an
            // ordinary error. An inactive selected tab instead stays in FileLoadingState forever.
            expect(screen.tree.findAllByType(FileErrorState)).toHaveLength(1);
            expect(screen.tree.findAllByType(FileLoadingState)).toHaveLength(0);
        });
    });

    it.each([undefined, false])('keeps a retained fullscreen file idle until focused (safe area: %s)', async (safeAreaPadding) => {
        focus.active = false;
        const { AppPaneProvider, FullscreenDetailsHarness } = await loadHarness();
        const screen = await renderScreen(<AppPaneProvider><FullscreenDetailsHarness paneOpen safeAreaPadding={safeAreaPadding} /></AppPaneProvider>);
        await vi.waitFor(() => {
            expect(screen.tree.findAllByType(SessionFileDetailsView)).toHaveLength(1);
        });
        expect(screen.tree.findAllByType(FileLoadingState)).toHaveLength(1);
        expect(screen.tree.findAllByType(FileErrorState)).toHaveLength(0);

        focus.active = true;
        await screen.update(<AppPaneProvider><FullscreenDetailsHarness paneOpen safeAreaPadding={safeAreaPadding} /></AppPaneProvider>);
        await vi.waitFor(() => {
            expect(screen.tree.findAllByType(FileErrorState)).toHaveLength(1);
            expect(screen.tree.findAllByType(FileLoadingState)).toHaveLength(0);
        });
    });
});
