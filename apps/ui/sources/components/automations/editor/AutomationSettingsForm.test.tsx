import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderScreen } from '@/dev/testkit';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';


const popoverBoundaryRefState = vi.hoisted(() => ({
    value: { current: { nodeName: 'BOUNDARY' } } as React.RefObject<any> | null,
}));

installAutomationComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Platform: {
                OS: 'web',
                select: <T,>(value: { web?: T; default?: T; ios?: T }) => value.web ?? value.default ?? value.ios,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');

        return createUnistylesMock({
            theme: {
                colors: {
                    input: {
                        background: '#fff',
                        placeholder: '#999',
                    },
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#777',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => popoverBoundaryRefState.value,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));
describe('AutomationSettingsForm', () => {
    it('uses automation-state toggle copy for automation-only flows', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        const screen = await renderScreen(<AutomationSettingsForm
            variant="create"
            value={{
                enabled: true,
                name: 'Nightly',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        const toggleItem = screen.findByProps({ title: 'automations.form.toggleEnabledTitle' });
        expect(toggleItem).toBeDefined();
        expect(toggleItem?.props.subtitle).toBe('automations.form.toggleEnabledSubtitle');
        expect(toggleItem?.props.rightElement).toBeDefined();
        expect(toggleItem?.props.rightElement?.props.value).toBe(true);
    });

    it('can hide the built-in enabled toggle group for inline composer usage', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        const screen = await renderScreen(<AutomationSettingsForm
            variant="new-session"
            showEnabledToggle={false}
            value={{
                enabled: true,
                name: 'Nightly',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        expect(screen.findAllByType('Switch' as any)).toHaveLength(0);
        const groups = screen.findAllByType('ItemGroup' as any).map((node) => node.props.title);
        expect(groups).toEqual([
            'automations.form.groupAutomationTitle',
            'automations.form.groupScheduleTitle',
        ]);
    });

    it('hides automation detail fields when the inline enabled toggle is off', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        const screen = await renderScreen(<AutomationSettingsForm
            variant="new-session"
            value={{
                enabled: false,
                name: 'Nightly',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        const groups = screen.findAllByType('ItemGroup' as any).map((node) => node.props.title);
        expect(groups).toEqual([
            'automations.form.groupAutomationTitle',
        ]);
        expect(screen.findAllByType('FieldItem' as any)).toHaveLength(0);
        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(0);
    });

    it('renders the schedule selector as a dropdown and updates schedule kind from the selected option', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');
        const onChange = vi.fn();

        const screen = await renderScreen(<AutomationSettingsForm
            variant="new-session"
            showEnabledToggle={false}
            value={{
                enabled: true,
                name: 'Daily summary',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={onChange}
        />);

        expect(screen.findAllByType('Item' as any)).toHaveLength(0);
        expect(screen.findAllByType('ItemGroupColumns' as any).length).toBeGreaterThan(0);
        expect(screen.findAllByType('FieldItem' as any).length).toBeGreaterThan(0);

        const dropdown = screen.findByType('DropdownMenu' as any);
        expect(screen.findAllByType('DropdownMenu' as any)).toHaveLength(1);
        expect(screen.findAllByType('ItemGroupColumns' as any)).toHaveLength(2);
        expect(dropdown.props.selectedId).toBe('interval');

        await act(async () => {
            dropdown.props.onSelect?.('cron');
        });

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'cron',
        }));
    });

    it('anchors the schedule dropdown to the current popover boundary while portaling on web to the body', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        const screen = await renderScreen(<AutomationSettingsForm
            variant="new-session"
            showEnabledToggle={false}
            value={{
                enabled: true,
                name: 'Daily summary',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        const dropdown = screen.findByType('DropdownMenu' as any);
        expect(dropdown.props.popoverBoundaryRef).toBe(popoverBoundaryRefState.value);
        expect(dropdown.props.popoverPortalWebTarget).toBe('body');
    });

    it('keeps timezone in the same two-column schedule row for cron mode', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        const screen = await renderScreen(<AutomationSettingsForm
            variant="new-session"
            showEnabledToggle={false}
            value={{
                enabled: true,
                name: 'Daily summary',
                description: '',
                scheduleKind: 'cron',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            }}
            onChange={() => {}}
        />);

        const scheduleColumns = screen.findAllByType('ItemGroupColumns' as any).at(-1);
        const scheduleColumnSpans = scheduleColumns?.findAllByType('ItemGroupColumn' as any).map((node) => node.props.span);
        expect(scheduleColumnSpans).toEqual([undefined, undefined]);
    });
});
