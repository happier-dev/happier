import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionIdSchema} from '@happier-dev/protocol/actions/actionIds';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { PersistedSessionMessagePinV1 } from '@happier-dev/session-core/pins';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor, executeDefaultActionInCapturedAccount } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { clearPersistedSessionMessagePinsStorage, readPersistedSessionMessagePins,
    reconcilePersistedSessionMessagePinRouteIds, subscribeSessionMessagePinsChanges } = await import('@/sync/domains/state/sessionMessagePinsPersistence');
const originalState = storage.getState();
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
const pin: PersistedSessionMessagePinV1 = {
    version: 1, sessionId: 'session-one', seq: 10, transcriptBlockIndex: 0,
    routeMessageId: 'local:pending-message', role: 'user', pinnedAtMs: 1000, label: 'Keep this turn',
};

beforeEach(async () => {
    storage.setState(originalState, true);
    home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
    clearPersistedSessionMessagePinsStorage(home.scope);
});
afterEach(async () => {
    standardCleanup();
    clearPersistedSessionMessagePinsStorage(home.scope);
    await home.dispose();
    storage.setState(originalState, true);
});

function execute(input: unknown) {
    return createDefaultActionExecutor().execute(ActionIdSchema.parse('session.messages.pins'), input,
        { surface: 'ui', authority: 'present_user', serverId: home.scope.serverId, runtimeAccountId: home.scope.accountId });
}

describe('device-local transcript message pin Action', () => {
    it('routes the transcript callback through Action admission before writing pins', async () => {
        const { useSessionTranscriptNavigationEntriesFromMessages } = await import('@/components/sessions/transcript/navigation/useSessionTranscriptNavigationEntries');
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntriesFromMessages({
            activeServerAccountScope: home.scope, forkedTranscriptEnabled: false,
            messageIdsOldestFirst: [], messagesById: {}, sessionId: pin.sessionId, remoteBackfillEnabled: false,
        }));
        await act(async () => { await rendered.getCurrent().togglePersistedSessionMessagePin(pin); });
        expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([pin]);
        home.replaceSettings(settingsParse({ ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.messages.pins': { enabled: false } } }),
        }));
        await act(async () => { await rendered.getCurrent().togglePersistedSessionMessagePin(pin); });
        expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([pin]);
    });

    it('pins, reads and unpins through real persistence, with repeated set operations publishing no changes', async () => {
        let publications = 0;
        const unsubscribe = subscribeSessionMessagePinsChanges(() => { publications += 1; });
        try {
            expect(await execute({ op: 'pin', sessionId: pin.sessionId, pin })).toMatchObject({
                ok: true, result: { status: 'ready', sessionId: pin.sessionId, pins: [pin] },
            });
            expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([pin]);
            expect(publications).toBe(1);
            expect(await execute({ op: 'pin', sessionId: pin.sessionId, pin })).toMatchObject({ ok: true });
            expect(await execute({ op: 'read', sessionId: pin.sessionId })).toMatchObject({ ok: true, result: { pins: [pin] } });
            expect(publications).toBe(1);
            expect(await execute({ op: 'unpin', sessionId: pin.sessionId, pin })).toMatchObject({ ok: true, result: { pins: [] } });
            expect(await execute({ op: 'unpin', sessionId: pin.sessionId, pin })).toMatchObject({ ok: true, result: { pins: [] } });
            expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([]);
            expect(publications).toBe(2);
        } finally { unsubscribe(); }
    });

    it('isolates Account, Home and Session and refuses a pin for another Session', async () => {
        await execute({ op: 'pin', sessionId: pin.sessionId, pin });
        expect(await execute({ op: 'read', sessionId: 'session-two' })).toMatchObject({ ok: true, result: { pins: [] } });
        expect(readPersistedSessionMessagePins(pin.sessionId, { ...home.scope, accountId: 'other-account' })).toEqual([]);
        expect(readPersistedSessionMessagePins(pin.sessionId, { ...home.scope, serverId: 'other-home' })).toEqual([]);
        expect(await execute({ op: 'pin', sessionId: 'session-two', pin })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(readPersistedSessionMessagePins('session-two', home.scope)).toEqual([]);
    });

    it('reads reconciled route identity and unpins it using the original fallback identity', async () => {
        await execute({ op: 'pin', sessionId: pin.sessionId, pin });
        reconcilePersistedSessionMessagePinRouteIds(pin.sessionId, [{
            seq: 10, transcriptBlockIndex: 0, routeMessageId: 'server:confirmed-message',
            previousRouteMessageIds: ['local:pending-message'], role: 'user',
        }], home.scope);
        expect(await execute({ op: 'read', sessionId: pin.sessionId })).toMatchObject({
            ok: true, result: { pins: [{ ...pin, routeMessageId: 'server:confirmed-message' }] },
        });
        expect(await execute({ op: 'unpin', sessionId: pin.sessionId, pin: { ...pin, routeMessageId: null } })).toMatchObject({
            ok: true, result: { pins: [] },
        });
    });

    it('rejects disabled Actions before any persisted effect', async () => {
        home.replaceSettings(settingsParse({ ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.messages.pins': { enabled: false } } }),
        }));
        expect(await execute({ op: 'pin', sessionId: pin.sessionId, pin })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([]);
    });

    it('rejects another expected Account and a retired captured Account before any write', async () => {
        const account = await captureLazyActionAccountContext(home.scope.serverId);
        try {
            await expect(executeDefaultActionInCapturedAccount(account, ActionIdSchema.parse('session.messages.pins'),
                { op: 'pin', sessionId: pin.sessionId, pin }, { surface: 'ui', authority: 'present_user', expectedAccountId: 'other-account' }))
                .rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([]);
            await home.dispose();
            await expect(executeDefaultActionInCapturedAccount(account, ActionIdSchema.parse('session.messages.pins'),
                { op: 'pin', sessionId: pin.sessionId, pin }, { surface: 'ui', authority: 'present_user' }))
                .rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(readPersistedSessionMessagePins(pin.sessionId, home.scope)).toEqual([]);
        } finally { account.dispose(); }
    });
});
