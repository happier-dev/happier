import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: createThemeFixture() });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => [],
            useLocalSettingMutable: () => [false, vi.fn()],
            useSessionMachineId: () => 'machine-1',
            useSessionWorkspacePath: () => '/srv/work/app',
            useSessionHomeDir: () => '/home/dax',
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: new Proxy({}, { get: () => () => ({}) }),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('./SessionDetailsPanelDetailViews', () => ({
    SessionCommitDetailsViewForPanel: (props: any) => React.createElement('SessionCommitDetailsViewForPanel', props),
    SessionFileDetailsViewForPanel: (props: any) => React.createElement('SessionFileDetailsViewForPanel', props),
    SessionScmReviewDetailsViewForPanel: (props: any) => React.createElement('SessionScmReviewDetailsViewForPanel', props),
    SessionScmStashDetailsViewForPanel: (props: any) => React.createElement('SessionScmStashDetailsViewForPanel', props),
    SessionSubagentDetailsViewForPanel: (props: any) => React.createElement('SessionSubagentDetailsViewForPanel', props),
}));

let mockAppPaneScope: any = null;
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => mockAppPaneScope,
}));

function createPaneScope(closeDetailsTab = vi.fn()) {
    return {
        closeDetails: vi.fn(),
        closeDetailsTab,
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'file:docs/notes.md',
                tabs: [
                    {
                        key: 'file:docs/notes.md',
                        kind: 'file',
                        title: 'notes.md',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'file', path: 'docs/notes.md' },
                    },
                ],
            },
        },
    };
}

async function renderPanelAndOpenTabMenu() {
    const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
    });
    const [tab] = tree!.root.findAll((node) => typeof node.props.onLongPress === 'function');
    await act(async () => {
        tab.props.onLongPress();
    });
    await act(async () => {
        await vi.dynamicImportSettled();
    });
    const menu = tree!.root.find((node) => node.props.items !== undefined && typeof node.props.onSelect === 'function');
    return { tree: tree!, menu };
}

// The menu pulls in the desktop setup and modal modules; the first import transforms them cold.
describe('SessionDetailsPanel (tab menu)', { timeout: 180_000 }, () => {
    // The browser window is the boundary: window.open is how a web build opens the file window.
    const open = vi.fn();
    beforeEach(() => {
        open.mockReset();
        Object.defineProperty(globalThis, 'window', {
            value: {
                open,
                screen: { availWidth: 1000, availHeight: 1000 },
                location: { href: 'http://localhost/session/s1' },
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
            },
            configurable: true,
            writable: true,
        });
    });
    afterEach(() => {
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it('opens a file tab in a separate window on the file-window route', async () => {
        mockAppPaneScope = createPaneScope();

        const { tree, menu } = await renderPanelAndOpenTabMenu();
        const itemIds = menu.props.items.map((item: { id: string }) => item.id);
        // Off the desktop app the file is not reachable locally, so only the window and close items show.
        expect(itemIds).toEqual(['openInNewWindow', 'closeTab']);

        await act(async () => {
            menu.props.onSelect('openInNewWindow');
        });
        expect(open).toHaveBeenCalledTimes(1);
        const [href, target, features] = open.mock.calls[0];
        const url = new URL(href, 'http://localhost');
        expect(url.pathname).toBe('/file-window');
        expect(url.searchParams.get('sessionId')).toBe('s1');
        expect(url.searchParams.get('path')).toBe('docs/notes.md');
        expect(target).toBe('_blank');
        expect(features).toContain('popup');

        await act(async () => {
            tree.unmount();
        });
    });

    it('closes the tab from its menu', async () => {
        const closeDetailsTab = vi.fn();
        mockAppPaneScope = createPaneScope(closeDetailsTab);

        const { tree, menu } = await renderPanelAndOpenTabMenu();
        await act(async () => {
            menu.props.onSelect('closeTab');
        });
        expect(closeDetailsTab).toHaveBeenCalledWith('file:docs/notes.md');

        await act(async () => {
            tree.unmount();
        });
    });
});
