import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const mockNavigateToSession = vi.fn();
const mockSessions = vi.hoisted(() => ({
    all: [] as any[],
    listViewDataByServerId: {} as Record<string, any[] | null>,
    hideInactiveSessions: false,
    pinnedSessionKeysV1: [] as string[],
    activeServerId: 'server-1' as string | null,
    organizationProjection: null as any,
    organizationProjectionByServerId: {} as Record<string, any>,
    profile: null as any,
}));
const modalMock = vi.hoisted(() => ({
    alert: vi.fn(),
}));
const fetchArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const fetchMoreSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const executeSessionActionMock = vi.hoisted(() => vi.fn(async () => undefined));

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
vi.mock('@/components/sessions/actions/sessionActionExecution', () => ({
    executeSessionAction: executeSessionActionMock,
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
                settings: settingsDefaults,
                sessions: {},
                machines: {},
            }),
            useAllSessions: () => mockSessions.all,
            useSessionListViewDataByServerId: () => mockSessions.listViewDataByServerId,
            useProfile: () => mockSessions.profile,
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

import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import { storage } from '@/sync/domains/state/storage';

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

function createOwnedArchivedSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'archived-owned',
        active: false,
        archivedAt: 1710000000000,
        updatedAt: 20,
        metadata: { name: 'Owned Archived Session', path: '/tmp/owned' },
        serverId: 'server-archived',
        ...overrides,
    };
}

function findNodesByAccessibilityLabel(root: any, label: string) {
    return root.findAll((node: any) => node.props?.accessibilityLabel === label);
}

describe('Archived sessions delete action', () => {
    beforeEach(() => {
        storage.getState().settings = settingsDefaults;
        mockNavigateToSession.mockReset();
        modalMock.alert.mockReset();
        executeSessionActionMock.mockClear();
        fetchArchivedSessionsSpy.mockReset();
        fetchMoreArchivedSessionsSpy.mockReset();
        fetchMoreSessionsSpy.mockReset();
        mockSessions.hideInactiveSessions = false;
        mockSessions.pinnedSessionKeysV1 = [];
        mockSessions.activeServerId = 'server-1';
        mockSessions.organizationProjection = createOrganizationProjection();
        mockSessions.organizationProjectionByServerId = {};
        mockSessions.profile = null;
        mockSessions.all = [];
        mockSessions.listViewDataByServerId = {};
    });

    it('deletes an owned archived session only after destructive confirmation', async () => {
        mockSessions.all = [createOwnedArchivedSession()];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        const deleteButtons = findNodesByAccessibilityLabel(screen.root, 'sessionInfo.deleteSession');
        expect(deleteButtons.length).toBeGreaterThan(0);
        const deleteButton = deleteButtons.find((node: any) => typeof node.props?.onPress === 'function');
        expect(deleteButton).toBeTruthy();

        await pressTestInstanceAsync(deleteButton, 'delete session button');

        expect(modalMock.alert).toHaveBeenCalledTimes(1);
        expect(modalMock.alert).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            expect.arrayContaining([
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
                expect.objectContaining({ text: 'sessionInfo.deleteSession', style: 'destructive' }),
            ]),
        );

        // Nothing executes before the destructive confirmation is accepted.
        expect(executeSessionAction).not.toHaveBeenCalled();

        const alertButtons = modalMock.alert.mock.calls[0]?.[2] as Array<{ text?: string; style?: string; onPress?: () => void }>;
        const confirmOnPress = alertButtons?.find((button) => button.style === 'destructive')?.onPress;
        if (typeof confirmOnPress !== 'function') {
            throw new Error('expected the destructive confirmation button to expose onPress');
        }
        await act(async () => {
            await confirmOnPress();
        });

        expect(executeSessionAction).toHaveBeenCalledTimes(1);
        expect(executeSessionAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'ui.session.delete',
            target: expect.objectContaining({
                sessionId: 'archived-owned',
                serverId: 'server-archived',
                canDelete: true,
            }),
        }));
    });

    it('does not render the delete action for a session owned by another user, even while unarchive stays available', async () => {
        mockSessions.profile = { id: 'me' };
        mockSessions.all = [createOwnedArchivedSession({
            id: 'archived-shared',
            owner: 'someone-else',
            updatedAt: 30,
            metadata: { name: 'Shared Archived Session', path: '/tmp/shared' },
        })];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        // The row itself renders and unarchive remains available at this access level...
        expect(screen.getTextContent()).toContain('Shared Archived Session');
        expect(findNodesByAccessibilityLabel(screen.root, 'sessionInfo.unarchiveSession').length).toBeGreaterThan(0);
        // ...but delete is owner-only and must stay hidden.
        expect(findNodesByAccessibilityLabel(screen.root, 'sessionInfo.deleteSession')).toHaveLength(0);
    });

    it('does not render the delete action for rows in the hidden inactive section', async () => {
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

        expect(screen.getTextContent()).toContain('Inactive Session');
        expect(screen.getTextContent()).toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(findNodesByAccessibilityLabel(screen.root, 'sessionInfo.deleteSession')).toHaveLength(0);
    });

    it('still renders the unarchive action for an owned archived session', async () => {
        mockSessions.all = [createOwnedArchivedSession()];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        const unarchiveButtons = findNodesByAccessibilityLabel(screen.root, 'sessionInfo.unarchiveSession');
        expect(unarchiveButtons.length).toBeGreaterThan(0);
        expect(unarchiveButtons.some((node: any) => typeof node.props?.onPress === 'function')).toBe(true);
    });
});
