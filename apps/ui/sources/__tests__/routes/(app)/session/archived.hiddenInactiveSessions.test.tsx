import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const mockNavigateToSession = vi.fn();
let capturedSectionListProps: any | null = null;
const mockSessions = vi.hoisted(() => ({
    all: [] as any[],
    listViewDataByServerId: {} as Record<string, any[] | null>,
    hideInactiveSessions: false,
    pinnedSessionKeysV1: [] as string[],
    activeServerId: 'server-1' as string | null,
    organizationProjection: null as any,
    organizationProjectionByServerId: {} as Record<string, any>,
}));
const modalMock = vi.hoisted(() => ({
    alert: vi.fn(),
}));
const fetchArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        SectionList: ({ sections, renderItem, renderSectionHeader, keyExtractor, contentContainerStyle, ...rest }: any) => {
            capturedSectionListProps = { sections, renderItem, renderSectionHeader, keyExtractor, contentContainerStyle, ...rest };
            return React.createElement(
                'SectionList',
                { sections, contentContainerStyle, ...rest },
                sections.flatMap((section: any) => {
                    const sectionNodes = [];
                    if (renderSectionHeader) {
                        sectionNodes.push(
                            React.createElement(
                                React.Fragment,
                                { key: `${section.key}:header` },
                                renderSectionHeader({ section }),
                            ),
                        );
                    }
                    for (const [index, item] of section.data.entries()) {
                        sectionNodes.push(
                            React.createElement(
                                React.Fragment,
                                { key: keyExtractor?.(item, index) ?? `${section.key}:${index}` },
                                renderItem({ item, index, section }),
                            ),
                        );
                    }
                    return sectionNodes;
                }),
            );
        },
    });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props, null),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalMock.alert,
        },
    }).module;
});
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => mockNavigateToSession,
}));
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        activeServerId: mockSessions.activeServerId,
    }),
}));
vi.mock('@/sync/ops', () => ({
    sessionUnarchiveWithServerScope: vi.fn(async () => ({ success: true, archivedAt: null })),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        fetchArchivedSessions: fetchArchivedSessionsSpy,
        fetchMoreArchivedSessions: fetchMoreArchivedSessionsSpy,
        fetchMoreSessions: fetchMoreSessionsSpy,
    },
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock({
                sessions: {},
                machines: {},
            }),
            useAllSessions: () => mockSessions.all,
            useSessionListViewDataByServerId: () => mockSessions.listViewDataByServerId,
            useSessionOrganizationProjection: (serverId: string | null | undefined) => {
                const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
                return mockSessions.organizationProjectionByServerId[normalizedServerId] ?? mockSessions.organizationProjection;
            },
            useSessionOrganizationPinnedSessionKeys: () => {
                const projections = Object.keys(mockSessions.organizationProjectionByServerId).length > 0
                    ? Object.entries(mockSessions.organizationProjectionByServerId)
                    : mockSessions.activeServerId
                        ? [[mockSessions.activeServerId, mockSessions.organizationProjection]]
                        : [];
                return projections.flatMap(([serverId, projection]) => (
                    (projection as any)?.pinnedSessionIds ?? []
                ).map((sessionId: string) => `${serverId}:${sessionId}`));
            },
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return mockSessions.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return mockSessions.pinnedSessionKeysV1;
                return null;
            },
        },
    });
});

import { Modal } from '@/modal';
import { sessionUnarchiveWithServerScope } from '@/sync/ops';

describe('Archived sessions route', () => {
    beforeEach(() => {
        mockNavigateToSession.mockReset();
        capturedSectionListProps = null;
        modalMock.alert.mockReset();
        fetchArchivedSessionsSpy.mockReset();
        fetchMoreArchivedSessionsSpy.mockReset();
        fetchMoreSessionsSpy.mockReset();
        (sessionUnarchiveWithServerScope as any).mockReset?.();
        mockSessions.hideInactiveSessions = false;
        mockSessions.pinnedSessionKeysV1 = [];
        mockSessions.activeServerId = 'server-1';
        mockSessions.organizationProjection = createOrganizationProjection();
        mockSessions.organizationProjectionByServerId = {};
        mockSessions.all = [];
        mockSessions.listViewDataByServerId = {};
    });

    function createOrganizationProjection(overrides: Record<string, unknown> = {}) {
        return {
            schemaVersion: 1,
            version: 1,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
            ...overrides,
        };
    }

    it('shows inactive sessions before archived sessions only when hide inactive sessions is enabled', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
            },
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const content = screen.getTextContent();

        expect(content).toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content.indexOf('settingsFeatures.hiddenInactiveSessionsSectionTitle')).toBeLessThan(
            content.indexOf('sessionInfo.archivedSessions'),
        );
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionSubtitle');
        expect(content).toContain('Inactive Session');
    });

    it('filters hidden inactive sessions using server-backed organization pins instead of legacy pinned settings', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.pinnedSessionKeysV1 = ['server-1:inactive-1'];
        mockSessions.organizationProjection = createOrganizationProjection({
            pinnedSessionIds: [],
        });
        mockSessions.all = [
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Legacy Pinned Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const legacyOnlyScreen = await renderScreen(<Screen />);
        expect(legacyOnlyScreen.getTextContent()).toContain('Legacy Pinned Inactive Session');

        mockSessions.pinnedSessionKeysV1 = [];
        mockSessions.organizationProjection = createOrganizationProjection({
            pinnedSessionIds: ['inactive-1'],
            pinsBySessionId: {
                'inactive-1': {
                    sessionId: 'inactive-1',
                    sortKey: null,
                    pinnedAt: 1,
                },
            },
        });

        const serverBackedScreen = await renderScreen(<Screen />);
        expect(serverBackedScreen.getTextContent()).not.toContain('Legacy Pinned Inactive Session');
    });

    it('filters hidden inactive sessions using the pinned state for the owning server scope', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.activeServerId = 'server-a';
        mockSessions.organizationProjectionByServerId = {
            'server-a': createOrganizationProjection({
                pinnedSessionIds: [],
            }),
            'server-b': createOrganizationProjection({
                pinnedSessionIds: ['inactive-b'],
                pinsBySessionId: {
                    'inactive-b': {
                        sessionId: 'inactive-b',
                        sortKey: null,
                        pinnedAt: 1,
                    },
                },
            }),
        };
        mockSessions.organizationProjection = mockSessions.organizationProjectionByServerId['server-a'];
        mockSessions.all = [
            {
                id: 'inactive-b',
                active: false,
                archivedAt: null,
                updatedAt: 20,
                metadata: { name: 'Server B Pinned Inactive Session', path: '/tmp/server-b' },
                serverId: 'server-b',
            },
            {
                id: 'inactive-a',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Server A Unpinned Inactive Session', path: '/tmp/server-a' },
                serverId: 'server-a',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const content = screen.getTextContent();

        expect(content).not.toContain('Server B Pinned Inactive Session');
        expect(content).toContain('Server A Unpinned Inactive Session');
    });

    it('requests the archived session snapshot when the route opens', async () => {
        const Screen = (await import('@/app/(app)/session/archived')).default;
        await renderScreen(<Screen />);

        expect(fetchArchivedSessionsSpy).toHaveBeenCalledTimes(1);
    });

    it('loads more archived and hidden inactive sessions when the list reaches the end', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
                serverId: 'server-archived',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        await renderScreen(<Screen />);

        expect(typeof capturedSectionListProps?.onEndReached).toBe('function');
        capturedSectionListProps?.onEndReached?.();

        expect(fetchMoreSessionsSpy).toHaveBeenCalledTimes(1);
        expect(fetchMoreArchivedSessionsSpy).toHaveBeenCalledTimes(1);
    });

    it('shows archived cache-only list rows before full hydration finishes', async () => {
        mockSessions.listViewDataByServerId = {
            'server-cache': [
                {
                    type: 'session',
                    serverId: 'server-cache',
                    session: {
                        id: 'archived-cache-only',
                        active: false,
                        archivedAt: 123,
                        updatedAt: 20,
                        metadata: { name: 'Cached Archived Session', path: '/tmp/archived-cache' },
                        accessLevel: 'admin',
                    },
                },
            ],
        };

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        expect(screen.getTextContent()).toContain('Cached Archived Session');
    });

    it('keeps archived sessions distinct when server scopes reuse a session id', async () => {
        mockSessions.listViewDataByServerId = {
            'server-a': [
                {
                    type: 'session',
                    serverId: 'server-a',
                    session: {
                        id: 'shared-session',
                        active: false,
                        archivedAt: 123,
                        updatedAt: 20,
                        metadata: { name: 'Server A Archived Session', path: '/tmp/server-a' },
                        accessLevel: 'admin',
                    },
                },
            ],
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    session: {
                        id: 'shared-session',
                        active: false,
                        archivedAt: 124,
                        updatedAt: 30,
                        metadata: { name: 'Server B Archived Session', path: '/tmp/server-b' },
                        accessLevel: 'admin',
                    },
                },
            ],
        };

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const archivedSection = capturedSectionListProps?.sections.find((section: any) => section.key === 'archived');

        expect(archivedSection?.data).toHaveLength(2);
        expect(screen.getTextContent()).toContain('Server A Archived Session');
        expect(screen.getTextContent()).toContain('Server B Archived Session');

        const rowKeys = archivedSection.data.map((item: any, index: number) => capturedSectionListProps?.keyExtractor(item, index));
        expect(new Set(rowKeys)).toEqual(new Set(['server-a:shared-session', 'server-b:shared-session']));
    });

    it('does not show inactive sessions when hide inactive sessions is disabled', async () => {
        mockSessions.hideInactiveSessions = false;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
            },
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const content = screen.getTextContent();

        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).not.toContain('Inactive Session');
    });

    it('stops wheel propagation on web so the archived sessions page can scroll inside the shell', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        expect(screen.root).toBeTruthy();
        expect(typeof capturedSectionListProps?.onWheel).toBe('function');

        const stopPropagation = vi.fn();
        capturedSectionListProps?.onWheel?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('preserves the owning serverId when opening a hidden inactive session', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const pressable = screen.root.find((node: any) => typeof node.props?.onPress === 'function');

        pressable.props.onPress();

        expect(mockNavigateToSession).toHaveBeenCalledWith('inactive-1', { serverId: 'server-1' });
    });

    it('preserves the owning serverId when opening an archived session', async () => {
        mockSessions.hideInactiveSessions = false;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
                serverId: 'server-archived',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const pressable = screen.root.find((node: any) => typeof node.props?.onPress === 'function');

        pressable.props.onPress();

        expect(mockNavigateToSession).toHaveBeenCalledWith('archived-1', { serverId: 'server-archived' });
    });

    it('uses the owning serverId when unarchiving an archived session', async () => {
        mockSessions.hideInactiveSessions = false;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
                serverId: 'server-archived',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const unarchiveButton = screen.root.find((node: any) => node.props?.accessibilityLabel === 'sessionInfo.unarchiveSession');

        unarchiveButton.props.onPress();

        expect(Modal.alert).toHaveBeenCalledTimes(1);
        const [, , buttons] = (Modal.alert as any).mock.calls[0];
        const confirm = (buttons as any[]).find((button) => button?.text === 'sessionInfo.unarchiveSession');
        await confirm.onPress();

        expect(sessionUnarchiveWithServerScope).toHaveBeenCalledWith('archived-1', { serverId: 'server-archived' });
    });
});
