import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SessionChooserModal } from './SessionChooserModal';
import { ReportSessionSelectionModal } from './ReportSessionSelectionModal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import type { NativeCaptureSnapshot } from '@/desktop/capture/nativeCapture';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createNativeScreenCaptureAction } from '@/sync/ops/actions/screenCaptureActions';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

const captureBoundary = vi.hoisted(() => ({ receive: null as null | ((event: { payload: NativeCaptureSnapshot }) => void) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_event: string, receive: typeof captureBoundary.receive) => {
    captureBoundary.receive = receive;
    return () => { captureBoundary.receive = null; };
}) }));

// Native rendering is the only replaced boundary; store, index projection and picker remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const initialStorage = storage.getState();
function namedSession(id: string, name: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, metadata: { path: '/project', host: 'local', name }, ...overrides });
}
function seedPicker(byServer: Readonly<Record<string, ReadonlyArray<Session>>>, fullSessions: ReadonlyArray<Session> = []) {
    storage.setState({
        isDataReady: true,
        sessions: Object.fromEntries(fullSessions.map(session => [session.id, session])),
        sessionListIndexByServerId: Object.fromEntries(Object.entries(byServer).map(([serverId, sessions]) => [serverId,
            sessions.map(session => ({ type: 'session' as const, sessionId: session.id, serverId })),
        ])),
        sessionListRowsByServerId: Object.fromEntries(Object.entries(byServer).map(([serverId, sessions]) => [serverId,
            Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])),
        ])),
        ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
}
afterEach(() => {
    standardCleanup();
    setScreenSharingPrivacyActive(false);
    vi.unstubAllGlobals();
    storage.setState(initialStorage, true);
});

describe('SessionChooserModal', () => {
    it('hides chosen tags for deliberate screen sharing on web and restores mounted rows when it ends', async () => {
        seedPicker({ 'server-a': [namedSession('private', 'Private sharing session'), namedSession('ordinary', 'Ordinary session')] });
        storage.setState({
            settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { 'server-a': ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: {
                [buildSessionOrganizationSessionKey('server-a', 'private')]: { sessionId: 'private', tagIds: ['secret'] },
            },
        });
        const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        const screen = await renderScreen(<SessionChooserModal title="Sessions" searchPlaceholder="Search"
            emptyStateLabel="Empty" testID="sharing-picker" onSelectSession={vi.fn()} onClose={vi.fn()} onDismiss={vi.fn()} />);
        expect(screen.getTextContent()).toContain('Private sharing session');
        await act(async () => {
            expect(await executor.execute('screenCapture.privacy.set', { active: true }, { surface: 'ui' }))
                .toMatchObject({ ok: true, result: { active: true } });
        });
        expect(screen.getTextContent()).not.toContain('Private sharing session');
        expect(screen.getTextContent()).toContain('Ordinary session');
        await act(async () => {
            expect(await executor.execute('screenCapture.privacy.set', { active: false }, { surface: 'ui' }))
                .toMatchObject({ ok: true, result: { active: false } });
        });
        expect(screen.getTextContent()).toContain('Private sharing session');
    });

    it('hides opted-in tags during native recording and restores the picker when recording stops', async () => {
        seedPicker({ 'server-a': [namedSession('private', 'Private recording session'), namedSession('ordinary', 'Ordinary session')] });
        storage.setState({
            settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { 'server-a': ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: {
                [buildSessionOrganizationSessionKey('server-a', 'private')]: { sessionId: 'private', tagIds: ['secret'] },
            },
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(async () => ({ status: 'idle' })) });
        const screen = await renderScreen(<SessionChooserModal title="Sessions" searchPlaceholder="Search"
            emptyStateLabel="Empty" testID="recording-picker" onSelectSession={vi.fn()} onClose={vi.fn()} onDismiss={vi.fn()} />);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Private recording session');
        await act(async () => captureBoundary.receive?.({ payload: { status: 'recording', operationRef: 1,
            recording: { phase: 'recording', timing: { durationMs: 0, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null } } }));
        expect(screen.getTextContent()).not.toContain('Private recording session');
        expect(screen.getTextContent()).toContain('Ordinary session');
        await act(async () => captureBoundary.receive?.({ payload: { status: 'idle' } }));
        expect(screen.getTextContent()).toContain('Private recording session');
    });

    it('preserves the caller title and modal identity when publishing responsive card chrome', async () => {
        const setChrome = vi.fn();
        await renderScreen(<SessionChooserModal
            title="Picker title" searchPlaceholder="Search" emptyStateLabel="Empty" testID="session-picker"
            setChrome={setChrome} onSelectSession={vi.fn()} onClose={vi.fn()} onDismiss={vi.fn()}
        />);
        expect(setChrome).toHaveBeenLastCalledWith(expect.objectContaining({
            title: 'Picker title', testID: 'session-picker-modal',
        }));
    });

    it('shows each server identity and returns the chosen address when session ids repeat across servers', async () => {
        seedPicker({
            'server-a': [namedSession('shared', 'First server')],
            'server-b': [namedSession('shared', 'Second server')],
        });
        const onSelectSession = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<SessionChooserModal
            title="Related session" searchPlaceholder="Search sessions" emptyStateLabel="No sessions"
            testID="session-picker" onSelectSession={onSelectSession} onClose={onClose} onDismiss={vi.fn()}
        />);
        expect(screen.getTextContent()).toContain('Second server');
        const row = screen.tree.root.findAll(node => node.props.title === 'Second server' && typeof node.props.onPress === 'function')[0];
        await pressTestInstanceAsync(row, 'second server session');
        expect(onSelectSession).toHaveBeenCalledWith({ sessionId: 'shared', serverId: 'server-b' });
        expect(onClose).toHaveBeenCalledOnce();
        expect(screen.getTextContent()).toContain('server-a');
        expect(screen.getTextContent()).toContain('server-b');
    });
    it('offers reports current, read-only, offline and other-server sessions, plus an explicit clear choice', async () => {
        const current = namedSession('current', 'Current read-only session', { serverId: 'server-a', accessLevel: 'view', meaningfulActivityAt: 600_000 });
        const offline = namedSession('offline', 'Offline session', { serverId: 'server-a', active: false, presence: 0, meaningfulActivityAt: 300_000 });
        const other = namedSession('other', 'Other server session', { accessLevel: 'view', meaningfulActivityAt: 900_000 });
        const hidden = namedSession('hidden', 'Hidden system session', {
            metadata: { path: '/project', host: 'local', name: 'Hidden system session', systemSessionV1: { v: 1, key: 'voice', hidden: true } },
        });
        seedPicker({ 'server-a': [current, offline], 'server-b': [other, hidden] }, [current, offline]);
        const onResolve = vi.fn();
        const screen = await renderScreen(<ReportSessionSelectionModal onResolve={onResolve} onClose={vi.fn()} />);
        const text = screen.getTextContent();
        expect(text).toContain('Current read-only session');
        expect(text).toContain('Offline session');
        expect(text).toContain('Other server session');
        expect(text).not.toContain('Hidden system session');
        expect(text).not.toContain('New session');
        expect(text.indexOf('Other server session')).toBeLessThan(text.indexOf('Current read-only session'));
        // One pressable row for the Session; the row owner's composite layers forward the same identity.
        expect(new Set(screen.tree.root.findAll(node => node.props.title === 'Current read-only session'
            && typeof node.props.onPress === 'function').map(node => node.props.testID))).toEqual(new Set(['report-session-selection-option-current']));
        await screen.pressByTestIdAsync('report-session-selection-list:report-session-selection-root:option:no-related-session');
        expect(onResolve).toHaveBeenLastCalledWith(null);
        const row = screen.tree.root.findAll(node => node.props.title === 'Current read-only session' && typeof node.props.onPress === 'function')[0];
        await pressTestInstanceAsync(row, 'current session');
        await vi.waitFor(() => expect(onResolve).toHaveBeenLastCalledWith({ sessionId: 'current', serverId: 'server-a', accountId: null }));
    });

    it('omits the clear choice when not allowed while retaining the shared empty state', async () => {
        seedPicker({});
        const screen = await renderScreen(<ReportSessionSelectionModal allowNoSession={false} onResolve={vi.fn()} onClose={vi.fn()} />);
        expect(screen.findByTestId('report-session-selection-list:report-session-selection-root:option:no-related-session')).toBeNull();
        expect(screen.findByTestId('report-session-selection-list:empty')).not.toBeNull();
    });

    it('captures the selected server account on selection and resolves before closing', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://report-picker-account.example' });
        const session = namedSession('scoped-session', 'Scoped session');
        seedPicker({ [profile.id]: [session] });
        const credentials = createDeferred<Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>>();
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(() => credentials.promise);
        const onResolve = vi.fn();
        const onClose = vi.fn();
        try {
            const screen = await renderScreen(<ReportSessionSelectionModal onResolve={onResolve} onClose={onClose} />);
            expect(credentialRead).not.toHaveBeenCalled();
            const row = screen.tree.root.findAll(node => node.props.title === 'Scoped session' && typeof node.props.onPress === 'function')[0];
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
