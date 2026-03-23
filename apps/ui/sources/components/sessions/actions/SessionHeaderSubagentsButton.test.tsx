import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                    View: ({ children, ...props }: any) => React.createElement('View', props, children),
                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/icons/DependabotIcon', () => ({
    DependabotIcon: 'DependabotIcon',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                header: { tint: '#000' },
                text: '#000',
                textSecondary: '#666',
                accent: {
                    blue: '#007AFF',
                    green: '#34C759',
                    orange: '#FF9500',
                    yellow: '#FFCC00',
                    red: '#FF3B30',
                    indigo: '#5856D6',
                    purple: '#AF52DE',
                },
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, values?: Record<string, unknown>) =>
        key === 'session.openSubagents' && values && typeof values.count === 'number'
            ? `session.openSubagents:${values.count}`
            : key });
});

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:s1',
        scopeState: {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
        },
        openRight: openRightSpy,
        closeRight: vi.fn(),
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

describe('SessionHeaderSubagentsButton', () => {
    it('opens the right panel on the agents tab when pressed', async () => {
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();

        const modulePromise = import('./SessionHeaderSubagentsButton');
        await expect(modulePromise).resolves.toHaveProperty('SessionHeaderSubagentsButton');
        const { SessionHeaderSubagentsButton } = await modulePromise;

        const screen = await renderScreen(
            <SessionHeaderSubagentsButton
                scopeId="session:s1"
                activeCount={2}
                hasAnySubagents={true}
            />
        );

        const pressable = screen.findByProps({ accessibilityLabel: 'session.openSubagents:2' });
        await pressTestInstanceAsync(pressable);

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'agents' });
        expect(setRightTabSpy).toHaveBeenCalledWith('agents');
        expect(findTestInstanceByTypeContainingText(screen, 'Text', '2')).toBeTruthy();
        expect(findTestInstanceByTypeWithProps(screen, 'DependabotIcon', { size: 21 })).toBeTruthy();
    });
});
