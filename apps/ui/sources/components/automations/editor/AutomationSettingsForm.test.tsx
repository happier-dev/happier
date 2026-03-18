import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#eee', placeholder: '#999' },
                text: '#111',
                textSecondary: '#777',
                divider: '#ddd',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                input: { background: '#eee', placeholder: '#999' },
                text: '#111',
                textSecondary: '#777',
                divider: '#ddd',
            },
        }),
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('AutomationSettingsForm', () => {
    it('treats the create variant like the new-session authoring mode', async () => {
        const { AutomationSettingsForm } = await import('./AutomationSettingsForm');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AutomationSettingsForm
                    variant="create"
                    value={{
                        enabled: true,
                        name: 'Nightly summary',
                        description: '',
                        scheduleKind: 'interval',
                        everyMinutes: 60,
                        cronExpr: '0 * * * *',
                        timezone: null,
                    }}
                    onChange={vi.fn()}
                />,
            );
        });

        const rows = tree.root.findAllByType('Item');
        expect(rows[0].props.title).toBe('automations.form.toggleEnableTitle');
    });
});
