import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';

const catalogState = vi.hoisted(() => ({ pages: [] as ResolvedSettingsPageNode[] }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => ({
        tree: [{
            id: 'settings',
            title: 'Settings',
            route: '/settings',
            keywords: [],
            children: [{
                id: 'groupSessionsBehavior',
                title: 'Sessions',
                keywords: [],
                children: catalogState.pages,
            }],
        }],
        activePageId: null,
        search: () => [],
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('SettingsSessionsBehaviorSection external sessions entry', () => {
    it('opens the External Sessions page when the resolved catalog admits it', async () => {
        catalogState.pages = [{
            id: 'externalSessions',
            title: 'externalSessions.settingsTitle',
            route: '/settings/external-sessions',
            keywords: [],
        }];
        const push = vi.fn();
        const { SettingsSessionsBehaviorSection } = await import('./SettingsSessionsBehaviorSection');
        const screen = await renderSettingsView(
            <SettingsSessionsBehaviorSection
                automationsNeedLocalEnablement={false}
                router={{ push } as never}
                showAutomations={false}
                terminalUseTmux={false}
                theme={{ colors: { accent: { blue: '#00f', indigo: '#50f', orange: '#f80' } } } as never}
            />,
        );

        expect(screen.findRowByTitle('externalSessions.settingsTitle')).toBeTruthy();
        screen.pressRowByTitle('externalSessions.settingsTitle');
        expect(push).toHaveBeenCalledWith('/settings/external-sessions');
    });

    it('does not invent the entry when the resolved catalog omits it', async () => {
        catalogState.pages = [];
        const { SettingsSessionsBehaviorSection } = await import('./SettingsSessionsBehaviorSection');
        const screen = await renderSettingsView(
            <SettingsSessionsBehaviorSection
                automationsNeedLocalEnablement={false}
                router={{ push: vi.fn() } as never}
                showAutomations={false}
                terminalUseTmux={false}
                theme={{ colors: { accent: { blue: '#00f', indigo: '#50f', orange: '#f80' } } } as never}
            />,
        );

        expect(screen.findRowByTitle('externalSessions.settingsTitle')).toBeNull();
    });
});
