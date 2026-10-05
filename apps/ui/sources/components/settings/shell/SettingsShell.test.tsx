import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SettingsShell } from './SettingsShell';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeader } from '@/components/ui/layout/PageHeader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowDimsState = vi.hoisted(() => ({ width: 1600, height: 900 }));
const localSettingsState = vi.hoisted(() => ({
    values: new Map<string, unknown>([
        ['settingsNavSidebarWidthPx', 230],
        ['settingsNavSidebarWidthBasisPx', 1200],
        ['settingsNavSidebarEnabled', true],
    ]),
}));

vi.mock('@/components/ui/panels/ResizableDockedPane', () => ({
    ResizableDockedPane: (props: any) => React.createElement('ResizableDockedPane', props, props.children),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
        useWindowDimensions: () => ({ width: windowDimsState.width, height: windowDimsState.height, scale: 2, fontScale: 1 }),
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    return createStorageModuleStub({
        storage: createStorageStoreMock({ settings: settingsParse({}) }),
        useLocalSetting: (key: string) => localSettingsState.values.get(key) ?? null,
        useLocalSettingMutable: () => [320, vi.fn()],
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));

describe('SettingsShell', () => {
    afterEach(() => {
        windowDimsState.width = 1600;
        windowDimsState.height = 900;
        localSettingsState.values.set('settingsNavSidebarWidthPx', 230);
        localSettingsState.values.set('settingsNavSidebarWidthBasisPx', 1200);
        localSettingsState.values.set('settingsNavSidebarEnabled', true);
    });

    it('renders children without the sidebar on non-tablet layouts', async () => {
        windowDimsState.width = 390;
        windowDimsState.height = 844;
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeNull();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it.each([
        ['agents/custom', '/settings/agents'],
        ['agents', '/settings'],
    ])('keeps parent Back reachable for hosted narrow %s without a native header', async (pageId, parent) => {
        windowDimsState.width = 390;
        windowDimsState.height = 844;
        const replace = vi.fn();
        const screen = await renderScreen(<DestinationInstanceHost tabId="settings-tab"
            ref={{ kind: 'settings', params: { pageId } }}
            pathname={`/settings/${pageId}`} focused visible navigation={{ push: () => {}, replace, back: () => {} }}>
            <SettingsShell><PageHeader title="Add an ACP agent" /></SettingsShell>
        </DestinationInstanceHost>);
        expect(screen.findByTestId('settings-modal-back')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-modal-back');
        expect(replace).toHaveBeenCalledWith(parent);
    });

    it('renders the settings sidebar on tablet/desktop layouts', async () => {
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it('docks the nav rail on the left, with the resize handle on its inner (right) edge', async () => {
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        // A left-docked rail keeps its drag handle on the boundary with the content
        // pane (its right edge), so `resizeEdge` is 'right'.
        expect(screen.findByType('ResizableDockedPane').props.resizeEdge).toBe('right');
    });

    it('uses the default sidebar width when the local width setting is missing', async () => {
        localSettingsState.values.delete('settingsNavSidebarWidthPx');
        windowDimsState.width = 1600;
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByType('ResizableDockedPane').props.widthPx).toBe(230);
    });

    it('hides the settings sidebar when disabled by local settings', async () => {
        localSettingsState.values.set('settingsNavSidebarEnabled', false);
        const screen = await renderScreen(
            React.createElement(SettingsShell, null, React.createElement('Child', { testID: 'child' }))
        );

        expect(screen.findByTestId('settings-sidebar')).toBeNull();
        expect(screen.findByTestId('child')).toBeTruthy();
    });

    it('preserves the current page and its draft when viewport or sidebar visibility changes', async () => {
        function DraftPage() {
            const [draft, setDraft] = React.useState('');
            return React.createElement('DraftField', { testID: 'draft', value: draft, onChangeText: setDraft });
        }
        const content = () => React.createElement(SettingsShell, null, React.createElement(DraftPage));
        const screen = await renderScreen(
            content(),
        );
        const draft = screen.findByTestId('draft');
        await act(async () => {
            draft!.props.onChangeText('Unsaved settings edit');
        });

        for (const [width, sidebarEnabled] of [[390, true], [1600, true], [1600, false], [1600, true]] as const) {
            windowDimsState.width = width;
            localSettingsState.values.set('settingsNavSidebarEnabled', sidebarEnabled);
            await act(async () => {
                screen.tree.update(content());
            });
            expect(screen.findByTestId('draft')?.props.value).toBe('Unsaved settings edit');
            expect(screen.findByTestId('draft')).toBe(draft);
        }
    });
});
