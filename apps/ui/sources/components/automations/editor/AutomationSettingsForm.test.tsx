import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Platform: { OS: 'web', select: (value: any) => value.web ?? value.default ?? value.ios },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                input: {
                    background: '#fff',
                    placeholder: '#999',
                },
                divider: '#ddd',
                text: '#111',
                textSecondary: '#777',
            },
        }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props, null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props, null),
}));

vi.mock('@/components/ui/forms/FieldItem', () => ({
    FieldItem: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FieldItem', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroupColumns', () => ({
    ItemGroupColumns: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroupColumns', props, props.children),
    ItemGroupColumn: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroupColumn', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('AutomationSettingsForm', () => {
    it('uses automation-state toggle copy for automation-only flows', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AutomationSettingsForm
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
                />,
            );
        });

        const toggleItem = tree.root.findAllByType('Item' as any).find((node) =>
            node.props.title === 'automations.form.toggleEnabledTitle'
        );
        expect(toggleItem).toBeDefined();
        expect(toggleItem?.props.subtitle).toBe('automations.form.toggleEnabledSubtitle');
        expect(toggleItem?.props.rightElement).toBeDefined();
        expect(toggleItem?.props.rightElement?.props.value).toBe(true);
    });

    it('can hide the built-in enabled toggle group for inline composer usage', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AutomationSettingsForm
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
                />,
            );
        });

        expect(tree.root.findAllByType('Switch' as any)).toHaveLength(0);
        const groups = tree.root.findAllByType('ItemGroup' as any).map((node) => node.props.title);
        expect(groups).toEqual([
            'automations.form.groupAutomationTitle',
            'automations.form.groupScheduleTitle',
        ]);
    });

    it('renders the schedule selector as a dropdown and updates schedule kind from the selected option', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');
        const onChange = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AutomationSettingsForm
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
                />,
            );
        });

        expect(tree.root.findAllByType('Item' as any)).toHaveLength(0);
        expect(tree.root.findAllByType('ItemGroupColumns' as any).length).toBeGreaterThan(0);
        expect(tree.root.findAllByType('FieldItem' as any).length).toBeGreaterThan(0);

        const scheduleGroup = tree.root.findAllByType('ItemGroup' as any).find((node) =>
            node.props.title === 'automations.form.groupScheduleTitle'
        );
        expect(scheduleGroup?.children.map((child) => {
            if (typeof child === 'object' && child !== null && 'type' in child) {
                return typeof child.type === 'function'
                    ? child.type.name
                    : child.type;
            }
            return child;
        })).toEqual([
            'DropdownMenu',
            'ItemGroupColumns',
        ]);

        const dropdown = tree.root.findByType('DropdownMenu' as any);
        expect(dropdown.props.selectedId).toBe('interval');

        await act(async () => {
            dropdown.props.onSelect?.('cron');
        });

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'cron',
        }));
    });

    it('keeps timezone in the same two-column schedule row for cron mode', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AutomationSettingsForm
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
                />,
            );
        });

        const scheduleColumns = tree.root.findAllByType('ItemGroupColumns' as any).at(-1);
        const scheduleColumnSpans = scheduleColumns?.findAllByType('ItemGroupColumn' as any).map((node) => node.props.span);
        expect(scheduleColumnSpans).toEqual([undefined, undefined]);
    });
});
