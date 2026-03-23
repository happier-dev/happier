import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                warningCritical: '#f00',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => {
        const labels: Record<string, string> = {
            'automations.create.unavailableGroupTitle': 'Unavailable',
            'automations.create.cannotCreateForSession': 'Cannot create automation for this session',
        };
        return labels[key] ?? key;
    },
    });
});

describe('ExistingSessionAutomationUnavailableNotice', () => {
    it('renders the shared blocked-state item group and reason', async () => {
        const { ExistingSessionAutomationUnavailableNotice } = await import('./ExistingSessionAutomationUnavailableNotice');

        const screen = await renderScreen(
            <ExistingSessionAutomationUnavailableNotice reason="This session does not have a resume encryption key loaded yet." />,
        );

        const group = screen.findByType('ItemGroup' as any);
        const row = screen.findByType('Item' as any);

        expect(group.props.title).toBe('Unavailable');
        expect(row.props.title).toBe('Cannot create automation for this session');
        expect(row.props.subtitle).toBe('This session does not have a resume encryption key loaded yet.');
        expect(row.props.showChevron).toBe(false);
    });
});
