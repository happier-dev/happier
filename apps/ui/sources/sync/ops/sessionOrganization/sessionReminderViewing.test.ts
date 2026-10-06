import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAttentionStanding, SessionOrganizationSnapshot } from '@happier-dev/protocol';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createDeferred, standardCleanup } from '@/dev/testkit';

import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { beginSessionReminderViewing } from './sessionReminderViewing';
import { setSessionAttentionStanding } from './setSessionAttentionStanding';

const api = vi.hoisted(() => ({ setSessionAttentionStanding: vi.fn() }));
// HTTP is the boundary; scope resolution, optimistic state, and reconciliation remain real.
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>(),
    setSessionAttentionStanding: api.setSessionAttentionStanding,
}));

const SERVER_URL = 'https://reminder-viewing.example';
const SERVER_ID = 'srv_reminder';
const SESSION_ID = 'session';
const KEY = buildSessionOrganizationSessionKey(SERVER_ID, SESSION_ID);
const store = getStorage();

function snapshot(record?: SessionAttentionStanding): SessionOrganizationSnapshot {
    return { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
        tagAssignments: [], orderEntries: [], labels: [], attentionStandings: record ? [record] : [] };
}
function setRecord(remindAt?: number): void {
    const id = store.getState().setSessionAttentionStandingOptimistic(SERVER_ID, SESSION_ID,
        { sessionId: SESSION_ID, standing: false, ...(remindAt === undefined ? {} : { remindAt }), updatedAt: 1 });
    store.getState().commitSessionOrganizationOptimistic(id);
}

const stopViewing: (() => void)[] = [];
function open(serverId: string = SERVER_ID): void {
    stopViewing.push(beginSessionReminderViewing({ sessionId: SESSION_ID, serverId }));
}

describe('session reminder viewing', () => {
    beforeEach(async () => {
        await upsertServerProfile({ serverUrl: SERVER_URL });
        await setServerProfileIdentityForUrl(SERVER_URL, SERVER_ID);
        store.getState().clearSessionOrganizationForServer(SERVER_ID);
        store.getState().applySettingsLocal({ sessionReminderAutoClearOnOpen: true });
        api.setSessionAttentionStanding.mockReset();
        api.setSessionAttentionStanding.mockResolvedValue({ standing: null });
        vi.spyOn(Date, 'now').mockReturnValue(1000);
    });
    afterEach(() => {
        stopViewing.splice(0).forEach((stop) => stop());
        store.getState().clearSessionOrganizationForServer(SERVER_ID);
        store.getState().applySettingsLocal({ sessionReminderAutoClearOnOpen: true });
        standardCleanup();
        vi.restoreAllMocks();
    });

    it.each(['absent', 'future', 'manual'] as const)('does no credential lookup, network write, or store update for %s reminders', (kind) => {
        store.getState().applySessionOrganizationSnapshot(SERVER_ID, snapshot());
        if (kind === 'future') setRecord(1001);
        if (kind === 'manual') {
            setRecord(1000);
            store.getState().applySettingsLocal({ sessionReminderAutoClearOnOpen: false });
        }
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const before = store.getState();
        const notifications = vi.fn();
        const unsubscribe = store.subscribe(notifications);
        open();
        expect(credentials).not.toHaveBeenCalled();
        expect(api.setSessionAttentionStanding).not.toHaveBeenCalled();
        expect(store.getState()).toBe(before);
        expect(notifications).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('clears at the due boundary with the canonical scope and only one write for concurrent panes', async () => {
        setRecord(1000);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token', secret: 'secret' });
        open((await upsertServerProfile({ serverUrl: SERVER_URL })).id);
        open();
        await vi.waitFor(() => expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]).toBeUndefined());
        expect(api.setSessionAttentionStanding).toHaveBeenCalledTimes(1);
        expect(api.setSessionAttentionStanding).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: SERVER_URL, sessionId: SESSION_ID, request: { remindAt: null },
        }));
    });

    it.each(['reschedule', 'manual'] as const)('preserves a %s change while credentials are loading', async (kind) => {
        setRecord(1000);
        const credentials = createDeferred<{ token: string; secret: string }>();
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockReturnValue(credentials.promise);
        open();
        if (kind === 'reschedule') setRecord(2000);
        else store.getState().applySettingsLocal({ sessionReminderAutoClearOnOpen: false });
        credentials.resolve({ token: 'token', secret: 'secret' });
        await credentials.promise;
        expect(api.setSessionAttentionStanding).not.toHaveBeenCalled();
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]?.remindAt)
            .toBe(kind === 'reschedule' ? 2000 : 1000);
    });

    it('clears the opened reminder across an unrelated reminder refresh while credentials are loading', async () => {
        setRecord(1000);
        const openedRecord = store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY];
        const credentials = createDeferred<{ token: string; secret: string }>();
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockReturnValue(credentials.promise);
        open();
        store.getState().applySessionOrganizationSnapshot(SERVER_ID, {
            ...snapshot(),
            attentionStandings: [
                { ...openedRecord },
                { sessionId: 'other-session', standing: false, remindAt: 2000, updatedAt: 2 },
            ],
        });
        credentials.resolve({ token: 'token', secret: 'secret' });
        await vi.waitFor(() => expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]).toBeUndefined());
    });

    it('acknowledges a due reminder from initial hydration and then stops observing', async () => {
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token', secret: 'secret' });
        open();
        expect(api.setSessionAttentionStanding).not.toHaveBeenCalled();
        store.getState().applySessionOrganizationSnapshot(SERVER_ID, snapshot({
            sessionId: SESSION_ID, standing: false, remindAt: 1000, updatedAt: 1,
        }));
        await vi.waitFor(() => expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]).toBeUndefined());
        setRecord(999);
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]?.remindAt).toBe(999);
        expect(api.setSessionAttentionStanding).toHaveBeenCalledTimes(1);
    });

    it('does not clear a reminder hydrated after leaving the session', () => {
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        open();
        stopViewing.pop()?.();
        store.getState().applySessionOrganizationSnapshot(SERVER_ID, snapshot({
            sessionId: SESSION_ID, standing: false, remindAt: 1000, updatedAt: 1,
        }));
        expect(credentials).not.toHaveBeenCalled();
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]?.remindAt).toBe(1000);
    });

    it('restores a failed clear, reports it, and retries on the next opening', async () => {
        setRecord(1000);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token', secret: 'secret' });
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        api.setSessionAttentionStanding.mockRejectedValueOnce(new Error('offline'));
        open();
        await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith(
            '[fireAndForget] sessionReminderViewing.clearDueReminder', expect.objectContaining({ message: 'offline' }),
        ));
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]?.remindAt).toBe(1000);
        open();
        await vi.waitFor(() => expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]).toBeUndefined());
    });

    it.each(['success', 'failure'] as const)('does not overwrite a new reminder with an older clear %s', async (outcome) => {
        setRecord(1000);
        const credentials = { token: 'token', secret: 'secret' };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        const clearResponse = createDeferred<{ standing: null }>();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        api.setSessionAttentionStanding.mockReturnValueOnce(clearResponse.promise);
        open();
        await vi.waitFor(() => expect(api.setSessionAttentionStanding).toHaveBeenCalledTimes(1));
        const replacement = { sessionId: SESSION_ID, standing: false, remindAt: 2000, updatedAt: 2 };
        api.setSessionAttentionStanding.mockResolvedValueOnce({ standing: replacement });
        await setSessionAttentionStanding({ credentials, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 2000 });
        if (outcome === 'success') clearResponse.resolve({ standing: null });
        else clearResponse.reject(new Error('offline'));
        await vi.waitFor(() => expect(store.getState().sessionOrganizationOptimisticRecords).toEqual({}));
        expect(store.getState().sessionOrganizationAttentionStandingsBySessionKey[KEY]).toEqual(replacement);
    });
});
