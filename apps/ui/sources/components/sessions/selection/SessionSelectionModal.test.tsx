import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installAgentAssetLoader } from '@/dev/testkit/mocks/agentAssets';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { Session } from '@/sync/domains/state/storageTypes';

import { SessionSelectionModal } from './SessionSelectionModal';
import { ReportSessionSelectionModal } from './ReportSessionSelectionModal';

// The picker, list, candidate assembly and store remain real below the native boundary.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const initialStorage = storage.getState();

function listItem(session: Session, serverId: string): SessionListViewItem {
    return { type: 'session', session: buildSessionListRenderableFromSession(session), serverId };
}

function namedSession(id: string, name: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, metadata: { path: '/project', host: 'local', name }, ...overrides });
}

beforeEach(installAgentAssetLoader);
afterEach(() => {
    standardCleanup();
    storage.setState(initialStorage, true);
});

describe('SessionSelectionModal', () => {
    it('keeps the caller title and modal identity when publishing responsive card chrome', async () => {
        const setChrome = vi.fn();
        await renderScreen(<SessionSelectionModal
            title="Picker title" searchPlaceholder="Search" emptyStateLabel="Empty" testID="session-picker"
            setChrome={setChrome} onSelectSession={vi.fn()} onClose={vi.fn()} onDismiss={vi.fn()}
        />);
        expect(setChrome).toHaveBeenLastCalledWith(expect.objectContaining({
            title: 'Picker title', testID: 'session-picker-modal',
        }));
    });

    it('returns the selected server identity when different servers have the same session id', async () => {
        storage.setState({
            isDataReady: true,
            sessions: {},
            sessionListViewDataByServerId: {
                'server-a': [listItem(namedSession('shared', 'First server'), 'server-a')],
                'server-b': [listItem(namedSession('shared', 'Second server'), 'server-b')],
            },
        });
        const onSelectSession = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<SessionSelectionModal
            title="Related session"
            searchPlaceholder="Search sessions"
            emptyStateLabel="No sessions"
            testID="session-picker"
            onSelectSession={onSelectSession}
            onClose={onClose}
            onDismiss={vi.fn()}
        />);

        expect(screen.getTextContent()).toContain('Second server');
        expect(screen.getTextContent()).toContain('server-a');
        expect(screen.getTextContent()).toContain('server-b');
        const secondServerRow = screen.tree.root.findAll((row) => row.props.title === 'Second server' && typeof row.props.onPress === 'function')[0];
        await pressTestInstanceAsync(secondServerRow, 'second server session');

        expect(onSelectSession).toHaveBeenCalledWith({ sessionId: 'shared', serverId: 'server-b' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('lets reports choose current, read-only, offline and other-server sessions without creating or sending to a session', async () => {
        const current = namedSession('current', 'Current read-only session', { serverId: 'server-a', accessLevel: 'view', meaningfulActivityAt: 600_000 });
        const offline = namedSession('offline', 'Offline session', { serverId: 'server-a', active: false, presence: 0, meaningfulActivityAt: 300_000 });
        const otherServer = namedSession('other', 'Other server session', { accessLevel: 'view', meaningfulActivityAt: 900_000 });
        const hidden = namedSession('hidden', 'Hidden system session', {
            metadata: { path: '/project', host: 'local', name: 'Hidden system session', systemSessionV1: { v: 1, key: 'voice', hidden: true } },
        });
        storage.setState({
            isDataReady: true,
            sessions: { current, offline },
            sessionListViewDataByServerId: {
                'server-a': [listItem(current, 'server-a'), listItem(offline, 'server-a')],
                'server-b': [listItem(otherServer, 'server-b'), listItem(hidden, 'server-b')],
            },
        });
        const onResolve = vi.fn();
        const screen = await renderScreen(<ReportSessionSelectionModal onResolve={onResolve} onClose={vi.fn()} />);
        const text = screen.getTextContent();
        expect(text).toContain('Current read-only session');
        expect(text).toContain('Offline session');
        expect(text).toContain('Other server session');
        expect(text).not.toContain('Hidden system session');
        expect(text).not.toContain('New session');
        expect(text.indexOf('Other server session')).toBeLessThan(text.indexOf('Current read-only session'));
        expect(screen.tree.root.findAll((row) => row.props.title === 'Current read-only session' && typeof row.props.onPress === 'function')).toHaveLength(1);

        await screen.pressByTestIdAsync('report-session-selection-list:report-session-selection-root:option:no-related-session');
        expect(onResolve).toHaveBeenLastCalledWith(null);
        const currentRow = screen.tree.root.findAll((row) => row.props.title === 'Current read-only session' && typeof row.props.onPress === 'function')[0];
        await pressTestInstanceAsync(currentRow, 'current session');
        await vi.waitFor(() => expect(onResolve).toHaveBeenLastCalledWith({ sessionId: 'current', serverId: 'server-a', accountId: null }));
    });

    it('omits the no-related-session choice when it is not allowed', async () => {
        storage.setState({ isDataReady: true, sessions: {}, sessionListViewDataByServerId: {} });
        const screen = await renderScreen(<ReportSessionSelectionModal allowNoSession={false} onResolve={vi.fn()} onClose={vi.fn()} />);
        expect(screen.findByTestId('report-session-selection-list:report-session-selection-root:option:no-related-session')).toBeNull();
        expect(screen.findByTestId('report-session-selection-empty')).not.toBeNull();
    });

    it('captures the selected server account on selection and resolves before closing', async () => {
        const profile = upsertServerProfile({ serverUrl: 'https://report-picker-account.example' });
        const session = namedSession('scoped-session', 'Scoped session');
        storage.setState({
            isDataReady: true,
            sessions: {},
            sessionListViewDataByServerId: { [profile.id]: [listItem(session, profile.id)] },
        });
        const credentials = createDeferred<Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>>();
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(() => credentials.promise);
        const onResolve = vi.fn();
        const onClose = vi.fn();
        try {
            const screen = await renderScreen(<ReportSessionSelectionModal onResolve={onResolve} onClose={onClose} />);
            expect(credentialRead).not.toHaveBeenCalled();
            const row = screen.tree.root.findAll((node) => node.props.title === 'Scoped session' && typeof node.props.onPress === 'function')[0];
            await pressTestInstanceAsync(row, 'scoped session');
            expect(credentialRead).toHaveBeenCalledWith(profile.serverUrl, { serverId: profile.id });
            expect(onResolve).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
            credentials.resolve({ token: `header.${Buffer.from(JSON.stringify({ sub: 'selected-account' })).toString('base64url')}.signature` });
            await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith({ sessionId: session.id, serverId: profile.id, accountId: 'selected-account' }));
            expect(onClose).toHaveBeenCalledOnce();
        } finally {
            credentialRead.mockRestore();
        }
    });
});
