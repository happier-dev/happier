import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createServerFetchWithReachabilityProbe, matchServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    type Row = Session | (SessionListRenderableSession & { serverId?: string });
    type Section = { key: string; title: string; data: Row[] };
    return createReactNativeWebMock({
        SectionList: ({ sections, renderItem, renderSectionHeader }: {
            sections: Section[];
            renderItem: (info: { item: Row; index: number; section: Section }) => React.ReactNode;
            renderSectionHeader: (info: { section: Section }) => React.ReactNode;
        }) => React.createElement('SectionList', null, sections.map((section) => (
            React.createElement(React.Fragment, { key: section.key },
                renderSectionHeader({ section }),
                section.data.map((item, index) => React.createElement(
                    React.Fragment,
                    { key: `${item.serverId}:${item.id}` },
                    renderItem({ item, index, section }),
                )),
            )
        ))),
    });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import * as runtimeFetch from '@/utils/system/runtimeFetch';

let serverA: ReturnType<typeof upsertServerProfile>;
let serverB: ReturnType<typeof upsertServerProfile>;
const modalAlert = vi.mocked(Modal.alert);
const modalConfirm = vi.mocked(Modal.confirm);
const token = 'header.eyJzdWIiOiJtZSJ9.signature';

function httpWithReachabilityProbe(handler: typeof runtimeFetch.runtimeFetch): typeof runtimeFetch.runtimeFetch {
    const fetch = createServerFetchWithReachabilityProbe(handler);
    return async (input, init) => {
        const response = await fetch(input, init);
        if (!(response instanceof Response)) throw new Error('Expected an HTTP response from the transport fixture');
        return response;
    };
}

function archivedSession(overrides: Partial<Session> = {}): Session {
    return createSessionFixture({
        id: 'archived-owned',
        serverId: serverA.id,
        archivedAt: 1710000000000,
        presence: 0,
        metadata: { name: 'Owned Archived Session', path: '/tmp/owned', host: 'tester.local' },
        ...overrides,
    });
}

function cacheArchivedSession(session: Session): void {
    storage.setState({
        sessionListViewDataByServerId: {
            [serverA.id]: [{ type: 'session', serverId: serverA.id, session: buildSessionListRenderableFromSession(session) }],
        },
    });
}

function actionButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
    return root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function');
}

// Exercise the real store, targeting, executor, sync operations, and server context.
// Only platform presentation, authentication persistence, and HTTP transport are stubbed.
describe('Archived sessions delete action', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        modalAlert.mockReset();
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValue(true);
        serverA = upsertServerProfile({ serverUrl: 'https://archive-a.example', name: 'Archive A' });
        serverB = upsertServerProfile({ serverUrl: 'https://archive-b.example', name: 'Archive B' });
        setActiveServerId(serverA.id);
        storage.setState({
            ...storage.getInitialState(),
            isDataReady: true,
            settings: settingsDefaults,
            profile: { ...profileDefaults, id: 'me' },
            sessions: {},
            sessionListViewDataByServerId: {},
        });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        vi.spyOn(apiSocket, 'request').mockResolvedValue(Response.json({}));
        vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(httpWithReachabilityProbe(
            async () => Response.json({}),
        ));
    });

    it('waits for confirmation and deletes the captured server row after a server switch, preserving a same-ID active session', async () => {
        const archived = archivedSession();
        storage.setState({ sessions: { [archived.id]: archived } });
        cacheArchivedSession(archived);
        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        const cancellation = createDeferred<boolean>();
        modalConfirm.mockReturnValueOnce(cancellation.promise);
        await pressTestInstanceAsync(actionButtons(screen.root, 'sessionInfo.deleteSession')[0]);
        expect(modalConfirm).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            expect.objectContaining({ destructive: true }),
        );
        expect(apiSocket.request).not.toHaveBeenCalled();
        expect(runtimeFetch.runtimeFetch).not.toHaveBeenCalled();
        await act(async () => { cancellation.resolve(false); });
        expect(apiSocket.request).not.toHaveBeenCalled();
        expect(runtimeFetch.runtimeFetch).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Owned Archived Session');

        const confirmation = createDeferred<boolean>();
        modalConfirm.mockReturnValueOnce(confirmation.promise);
        await pressTestInstanceAsync(actionButtons(screen.root, 'sessionInfo.deleteSession')[0]);
        const collision = archivedSession({ serverId: serverB.id, active: true, archivedAt: null });
        await act(async () => {
            setActiveServerId(serverB.id);
            storage.setState({ sessions: { [collision.id]: collision } });
        });
        await act(async () => { confirmation.resolve(true); });

        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Owned Archived Session'));
        const request = vi.mocked(runtimeFetch.runtimeFetch).mock.calls.find(([, init]) => init?.method === 'DELETE');
        expect(request?.[0]).toEqual(matchServerFetchUrl(`${serverA.serverUrl}/v1/sessions/${archived.id}`));
        expect(new Headers(request?.[1]?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(apiSocket.request).not.toHaveBeenCalled();
        expect(storage.getState().sessions[collision.id]).toBe(collision);
    });

    it('shows a server delete error, keeps the archived row, and lets the user retry', async () => {
        const archived = archivedSession();
        setActiveServerId(serverB.id);
        cacheArchivedSession(archived);
        const fetch = vi.mocked(runtimeFetch.runtimeFetch);
        let attempts = 0;
        fetch.mockImplementation(httpWithReachabilityProbe(async () => {
            attempts += 1;
            return attempts === 1 ? new Response('Delete rejected', { status: 500 }) : Response.json({});
        }));
        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        await pressTestInstanceAsync(actionButtons(screen.root, 'sessionInfo.deleteSession')[0]);
        await vi.waitFor(() => expect(modalAlert).toHaveBeenLastCalledWith('common.error', 'Delete rejected'));
        expect(screen.getTextContent()).toContain('Owned Archived Session');

        await pressTestInstanceAsync(actionButtons(screen.root, 'sessionInfo.deleteSession')[0]);
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Owned Archived Session'));
        expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
    });

    it('offers stop-and-delete for owned active and connected rows while withholding delete from ineligible rows', async () => {
        const rows = [
            archivedSession({ id: 'shared', owner: 'someone-else', accessLevel: 'admin', metadata: {
                name: 'Shared archive', path: '/tmp/shared', host: 'tester.local',
            } }),
            archivedSession({ id: 'active', active: true, metadata: {
                name: 'Active archive', path: '/tmp/active', host: 'tester.local',
            } }),
            archivedSession({ id: 'connected', presence: 'online', metadata: {
                name: 'Connected archive', path: '/tmp/connected', host: 'tester.local',
            } }),
            archivedSession({ id: 'preserved', metadata: {
                name: 'Preserved terminal', path: '/tmp/preserved', host: 'tester.local',
                terminal: { mode: 'zellij', controlServiceabilityV1: {
                    v: 1, attachmentId: 'preserved-terminal', state: 'unknown', observedAt: 124,
                } },
            } }),
            archivedSession({ id: 'hidden', archivedAt: null, metadata: {
                name: 'Hidden inactive', path: '/tmp/hidden', host: 'tester.local',
            } }),
        ];
        storage.setState({ sessions: Object.fromEntries(rows.map((session) => [session.id, session])), settings: {
            ...settingsDefaults, hideInactiveSessions: true,
        } });
        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        expect(screen.getTextContent()).toContain('Hidden inactive');
        expect(screen.getTextContent()).toContain('Preserved terminal');
        expect(screen.getTextContent()).toContain('Shared archive');
        expect(screen.getTextContent()).toContain('Active archive');
        expect(screen.getTextContent()).toContain('Connected archive');
        expect(actionButtons(screen.root, 'sessionInfo.deleteSession')).toHaveLength(2);
        for (const session of rows) {
            const title = screen.root.findAll((node) => node.props.children === session.metadata?.name)[0];
            expect(title).toBeDefined();
            let row = title.parent;
            while (row && typeof row.props.onPress !== 'function') row = row.parent;
            if (!row) throw new Error(`Expected session row for ${session.id}`);
            expect(actionButtons(row, 'sessionInfo.deleteSession')).toHaveLength(
                session.id === 'active' || session.id === 'connected' ? 1 : 0,
            );
        }
        expect(actionButtons(screen.root, 'sessionInfo.unarchiveSession').length).toBeGreaterThan(0);
    });

    it('unarchives through the real operation and removes the row from the archive screen', async () => {
        const archived = archivedSession();
        storage.setState({ sessions: { [archived.id]: archived } });
        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        await pressTestInstanceAsync(actionButtons(screen.root, 'sessionInfo.unarchiveSession')[0]);
        await vi.waitFor(() => expect(storage.getState().sessions[archived.id]?.archivedAt).toBeNull());
        expect(apiSocket.request).toHaveBeenCalledWith(`/v2/sessions/${archived.id}/unarchive`, { method: 'POST' });
        expect(screen.getTextContent()).not.toContain('Owned Archived Session');
    });
});
