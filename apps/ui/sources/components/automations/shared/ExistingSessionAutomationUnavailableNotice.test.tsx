import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                warningCritical: '#f00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => {
        const labels: Record<string, string> = {
            'automations.create.unavailableGroupTitle': 'Unavailable',
            'automations.create.cannotCreateForSession': 'Cannot create automation for this session',
        };
        return labels[key] ?? key;
    },
}));

describe('ExistingSessionAutomationUnavailableNotice', () => {
    it('renders the shared blocked-state item group and reason', async () => {
        const { ExistingSessionAutomationUnavailableNotice } = await import('./ExistingSessionAutomationUnavailableNotice');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ExistingSessionAutomationUnavailableNotice reason="This session does not have a resume encryption key loaded yet." />,
            );
        });

        const group = tree.root.findByType('ItemGroup');
        const row = tree.root.findByType('Item');

        expect(group.props.title).toBe('Unavailable');
        expect(row.props.title).toBe('Cannot create automation for this session');
        expect(row.props.subtitle).toBe('This session does not have a resume encryption key loaded yet.');
        expect(row.props.showChevron).toBe(false);
    });
});
