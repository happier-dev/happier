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
}));
const modalMock = vi.hoisted(() => ({
    alert: vi.fn(),
}));
const fetchArchivedSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
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
vi.mock('@/sync/ops', () => ({
    sessionUnarchiveWithServerScope: vi.fn(async () => ({ success: true, archivedAt: null })),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        fetchArchivedSessions: fetchArchivedSessionsSpy,
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
        (sessionUnarchiveWithServerScope as any).mockReset?.();
        mockSessions.hideInactiveSessions = false;
        mockSessions.pinnedSessionKeysV1 = [];
        mockSessions.all = [];
        mockSessions.listViewDataByServerId = {};
    });

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

    it('requests the archived session snapshot when the route opens', async () => {
        const Screen = (await import('@/app/(app)/session/archived')).default;
        await renderScreen(<Screen />);

        expect(fetchArchivedSessionsSpy).toHaveBeenCalledTimes(1);
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
