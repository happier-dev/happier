import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionActionsCommonModuleMocks({
    text: () =>
        createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) =>
                key === 'session.openSubagents' && values && typeof values.count === 'number'
                    ? `session.openSubagents:${values.count}`
                    : key,
        }),
});

vi.mock('@/components/ui/icons/DependabotIcon', () => ({
    DependabotIcon: 'DependabotIcon',
}));

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
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
    });

    it('opens the right panel on the agents tab when pressed', async () => {
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
