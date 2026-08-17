import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pressable } from 'react-native';

import { createStorageModuleStub, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/virtualizedList';
import { installSessionRouteCommonModuleMocks } from './[id]/sessionRouteTestHelpers';

const navigateToSessionSpy = vi.fn();
const flatListMock = createCapturingFlatListMock({ renderItems: true });
const fetchArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const sessionUnarchiveWithServerScopeSpy = vi.hoisted(() => vi.fn(async () => ({ success: true, archivedAt: null })));
const modalAlertSpy = vi.hoisted(() => vi.fn());
let capturedSectionListProps: any | null = null;
let hideInactiveSessions = false;
let pinnedSessionKeysV1: string[] = [];
let organizationPinnedSessionKeysV1: string[] = [];
let sessionListRowStateByServerId: Record<string, Record<string, any> | null> = {};
let allSessions: any[] = [];

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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
    },
    storageModule: async () => {
        return createStorageModuleStub({
            useAllSessions: () => allSessions as any,
            useSessionListRowStateByServerId: () => sessionListRowStateByServerId,
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return pinnedSessionKeysV1;
                return null;
            },
            useSessionOrganizationPinnedSessionKeys: () => organizationPinnedSessionKeysV1,
        });
    },
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});

vi.mock('@legendapp/list/section-list', () => ({
    SectionList: React.forwardRef((props: any, ref) => {
        capturedSectionListProps = props;
        if (typeof ref === 'function') ref(null);
        else if (ref && typeof ref === 'object') ref.current = null;
        return React.createElement(
            'LegendSectionList',
            props,
            ...(props.sections ?? []).flatMap((section: any, sectionIndex: number) => [
                props.renderSectionHeader ? props.renderSectionHeader({ section, index: sectionIndex }) : null,
                ...(section.data ?? []).map((item: any, index: number) => props.renderItem({ item, index, section })),
            ]),
        );
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchArchivedSessions: fetchArchivedSessionsSpy,
        fetchMoreArchivedSessions: fetchMoreArchivedSessionsSpy,
        fetchMoreSessions: fetchMoreSessionsSpy,
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionUnarchiveWithServerScope: sessionUnarchiveWithServerScopeSpy,
}));

describe('session history navigation', () => {
    beforeEach(() => {
        navigateToSessionSpy.mockReset();
        fetchArchivedSessionsSpy.mockReset();
        fetchMoreArchivedSessionsSpy.mockReset();
        fetchMoreSessionsSpy.mockReset();
        sessionUnarchiveWithServerScopeSpy.mockReset();
        sessionUnarchiveWithServerScopeSpy.mockResolvedValue({ success: true, archivedAt: null });
        modalAlertSpy.mockReset();
        capturedSectionListProps = null;
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = [];
        organizationPinnedSessionKeysV1 = [];
        sessionListRowStateByServerId = {};
        allSessions = [
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
        ];
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

    it('requests archived sessions when the archived route opens', async () => {
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        await renderScreen(React.createElement(ArchivedSessionsScreen));

        expect(fetchArchivedSessionsSpy).toHaveBeenCalledTimes(1);
    });

    it('loads more archived and hidden inactive pages when the archived route reaches the end', async () => {
        hideInactiveSessions = true;

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        await renderScreen(React.createElement(ArchivedSessionsScreen));

        expect(typeof capturedSectionListProps?.onEndReached).toBe('function');
        capturedSectionListProps?.onEndReached?.();

        expect(fetchMoreSessionsSpy).toHaveBeenCalledTimes(1);
        expect(fetchMoreArchivedSessionsSpy).toHaveBeenCalledTimes(1);
    });

    it('passes the row server id when unarchiving an archived session', async () => {
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        const unarchiveButton = screen.tree
            .findAllByType(Pressable)
            .find((node) => node.props.accessibilityRole === 'button');
        expect(unarchiveButton).toBeTruthy();

        await pressTestInstanceAsync(unarchiveButton!, 'archived session unarchive button');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const buttons = modalAlertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => Promise<void> | void }> | undefined;
        expect(buttons?.[1]?.onPress).toBeTypeOf('function');

        await buttons?.[1]?.onPress?.();

        expect(sessionUnarchiveWithServerScopeSpy).toHaveBeenCalledWith('session-archived-1', { serverId: 'server-archived' });
    });

    it('shows archived cache-only rows before full session hydration finishes', async () => {
        sessionListRowStateByServerId = {
            'server-cache': {
                'session-archived-cache': {
                    id: 'session-archived-cache',
                    active: false,
                    archivedAt: 150,
                    updatedAt: 150,
                    metadata: { name: 'Cached archived session' },
                    accessLevel: 'admin',
                },
            },
        };

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        expect(screen.getTextContent()).toContain('Cached archived session');
    });

    it('keeps archived rows distinct when server scopes reuse a session id', async () => {
        sessionListRowStateByServerId = {
            'server-a': {
                shared: {
                    id: 'shared-archived-session',
                    active: false,
                    archivedAt: 180,
                    updatedAt: 180,
                    metadata: { name: 'Server A archived session' },
                    accessLevel: 'admin',
                },
            },
            'server-b': {
                shared: {
                    id: 'shared-archived-session',
                    active: false,
                    archivedAt: 190,
                    updatedAt: 190,
                    metadata: { name: 'Server B archived session' },
                    accessLevel: 'admin',
                },
            },
        };

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        expect(screen.getTextContent()).toContain('Server A archived session');
        expect(screen.getTextContent()).toContain('Server B archived session');
        const archivedSection = capturedSectionListProps?.sections.find((section: any) => section.kind === 'archived');
        const rowKeys = archivedSection?.data.map((item: any, index: number) =>
            capturedSectionListProps?.keyExtractor(item, index),
        );
        expect(new Set(rowKeys)).toEqual(new Set([
            'server-archived:session-archived-1',
            'server-a:shared-archived-session',
            'server-b:shared-archived-session',
        ]));
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

    it('keeps the hidden Voice History carrier out of archived and hidden-inactive session lists', async () => {
        hideInactiveSessions = true;
        allSessions = [
            {
                id: 'session-ordinary-inactive',
                serverId: 'server-normal',
                updatedAt: 100,
                archivedAt: null,
                active: false,
                metadata: { name: 'Ordinary inactive session' },
            },
            {
                id: 'voice-history-hidden',
                serverId: 'server-voice',
                updatedAt: 90,
                archivedAt: null,
                active: false,
                metadataLayoutVersion: 1,
                metadataUnavailable: false,
                metadata: {
                    name: 'Voice History carrier',
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            },
            {
                id: 'voice-history-archived',
                serverId: 'server-voice',
                updatedAt: 80,
                archivedAt: 80,
                active: false,
                metadataLayoutVersion: 1,
                metadataUnavailable: false,
                metadata: {
                    name: 'Archived Voice History carrier',
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            },
        ];
        sessionListRowStateByServerId = {
            'server-cache': {
                'voice-history-archived-cache': {
                    id: 'voice-history-archived-cache',
                    archivedAt: 70,
                    active: false,
                    updatedAt: 70,
                    accessLevel: 'admin',
                    metadataLayoutVersion: 1,
                    metadataUnavailable: false,
                    metadata: {
                        name: 'Cached Voice History carrier',
                        systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                    },
                },
            },
        };

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).toContain('Ordinary inactive session');
        expect(content).not.toContain('Voice History carrier');
        expect(content).not.toContain('Archived Voice History carrier');
        expect(content).not.toContain('Cached Voice History carrier');
    });

    it('uses organization pins when filtering hidden inactive sessions on the archived screen', async () => {
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        organizationPinnedSessionKeysV1 = ['server-hidden:session-hidden-1'];

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).not.toContain('Hidden inactive session');
    });

    it('ignores legacy pinned settings when filtering hidden inactive sessions on the archived screen', async () => {
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = ['server-hidden:session-hidden-1'];
        organizationPinnedSessionKeysV1 = [];

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).toContain('Hidden inactive session');
    });

    it('filters hidden inactive sessions using the pinned state for each row server scope', async () => {
        hideInactiveSessions = true;
        organizationPinnedSessionKeysV1 = ['server-b:session-hidden-b'];
        allSessions = [
            {
                id: 'session-hidden-a',
                serverId: 'server-a',
                updatedAt: 80,
                archivedAt: null,
                active: false,
                metadata: { name: 'Server A unpinned inactive session' },
            },
            {
                id: 'session-hidden-b',
                serverId: 'server-b',
                updatedAt: 70,
                archivedAt: null,
                active: false,
                metadata: { name: 'Server B pinned inactive session' },
            },
        ];

        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));
        const content = screen.getTextContent();

        expect(content).toContain('Server A unpinned inactive session');
        expect(content).not.toContain('Server B pinned inactive session');
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
