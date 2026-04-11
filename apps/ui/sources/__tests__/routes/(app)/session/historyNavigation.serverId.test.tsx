import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pressable } from 'react-native';

import { createStorageModuleStub, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/flashList';
import { installSessionRouteCommonModuleMocks } from './[id]/sessionRouteTestHelpers';

const navigateToSessionSpy = vi.fn();
const flatListMock = createCapturingFlatListMock({ renderItems: true });
let capturedSectionListProps: any | null = null;
let hideInactiveSessions = false;
let pinnedSessionKeysV1: string[] = [];

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: flatListMock.module.FlatList,
            SectionList: (props: any) => React.createElement(
                'SectionList',
                (() => {
                    capturedSectionListProps = props;
                    return props;
                })(),
                ...(props.sections ?? []).flatMap((section: any, sectionIndex: number) => [
                    props.renderSectionHeader ? props.renderSectionHeader({ section, index: sectionIndex }) : null,
                    ...(section.data ?? []).map((item: any, index: number) => props.renderItem({ item, index, section })),
                ]),
            ),
        });
    },
    storageModule: async () => {
        return createStorageModuleStub({
            useAllSessions: () => [
                {
                    id: 'session-history-1',
                    serverId: 'server-history',
                    updatedAt: 100,
                    active: true,
                    metadata: { name: 'History session' },
                },
                {
                    id: 'session-archived-1',
                    serverId: 'server-archived',
                    updatedAt: 90,
                    archivedAt: 80,
                    metadata: { name: 'Archived session' },
                },
                {
                    id: 'session-hidden-1',
                    serverId: 'server-hidden',
                    updatedAt: 70,
                    archivedAt: null,
                    active: false,
                    metadata: { name: 'Hidden inactive session' },
                },
            ] as any,
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return pinnedSessionKeysV1;
                return null;
            },
        });
    },
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

describe('session history navigation', () => {
    beforeEach(() => {
        navigateToSessionSpy.mockReset();
        capturedSectionListProps = null;
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = [];
    });

    it('passes the row server id when navigating from recent sessions', async () => {
        const RecentSessionsScreen = (await import('@/app/(app)/session/recent')).default;
        const screen = await renderScreen(React.createElement(RecentSessionsScreen));

        const row = screen.tree.findAllByType(Pressable)[0];
        expect(row).toBeTruthy();

        await pressTestInstanceAsync(row!, 'history session row');

        expect(navigateToSessionSpy).toHaveBeenCalledWith('session-history-1', { serverId: 'server-history' });
    });

    it('passes the row server id when navigating from archived sessions', async () => {
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        const row = screen.tree.findAllByType(Pressable)[0];
        expect(row).toBeTruthy();

        await pressTestInstanceAsync(row!, 'archived session row');

        expect(navigateToSessionSpy).toHaveBeenCalledWith('session-archived-1', { serverId: 'server-archived' });
    });

    it('shows inactive sessions before archived sessions on the archived screen when hide inactive sessions is enabled', async () => {
        hideInactiveSessions = true;
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content.indexOf('settingsFeatures.hiddenInactiveSessionsSectionTitle')).toBeLessThan(
            content.indexOf('sessionInfo.archivedSessions'),
        );
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionSubtitle');

        const sessionRows = screen.tree.findAllByType(Pressable).filter((node) => node.props.accessibilityRole !== 'button');
        const hiddenSessionRow = sessionRows[0];
        expect(hiddenSessionRow).toBeTruthy();

        await pressTestInstanceAsync(hiddenSessionRow!, 'hidden inactive session row');

        expect(navigateToSessionSpy).toHaveBeenCalledWith('session-hidden-1', { serverId: 'server-hidden' });
    });

    it('does not show inactive sessions on the archived screen when hide inactive sessions is disabled', async () => {
        hideInactiveSessions = false;
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).not.toContain('Hidden inactive session');
    });

    it('stops wheel propagation on web so the archived sessions page can scroll inside the shell', async () => {
        hideInactiveSessions = true;
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        expect(screen.tree).toBeTruthy();
        expect(typeof capturedSectionListProps?.onWheel).toBe('function');

        const stopPropagation = vi.fn();
        capturedSectionListProps?.onWheel?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    afterEach(() => {
        standardCleanup();
    });
});
