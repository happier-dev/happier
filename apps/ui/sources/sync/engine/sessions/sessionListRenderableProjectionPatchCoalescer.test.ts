import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';
import {
    buildSessionListRenderableFromSession,
    type SessionListRenderablePatchFields,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRowPatchOperation } from '@/sync/store/domains/sessions';

import { createSessionListRenderableProjectionPatchCoalescer } from './sessionListRenderableProjectionPatchCoalescer';

const initialState = storage.getState();
const address = { serverId: 'server-a', sessionId: 'session-1' };

function seed(target: SessionAddress = address, fields: SessionListRenderablePatchFields = {}): SessionListRenderableSession {
    const row = { ...buildSessionListRenderableFromSession(createSessionFixture({
        id: target.sessionId, serverId: target.serverId, active: true, activeAt: 1, updatedAt: 1,
        meaningfulActivityAt: 1, thinking: false, thinkingAt: 0, archivedAt: null, agentStateVersion: 1,
    })), ...fields };
    storage.getState().applyServerScopedSessionListRows(target.serverId, [row], { source: 'ordinary', mode: 'append' });
    return storage.getState().sessionListRowsByServerId[target.serverId][target.sessionId];
}

function coalescer<Payload>(buildPatch: (current: SessionListRenderableSession, payload: Payload) => SessionListRenderablePatchFields) {
    return createSessionListRenderableProjectionPatchCoalescer<Payload>({
        getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
        buildPatch: ({ renderable, payload }) => buildPatch(renderable, payload),
        applyPatches: (patches) => {
            const byHome = new Map<string, Array<{ sessionId: string; patch: SessionListRowPatchOperation }>>();
            for (const entry of patches) {
                const group = byHome.get(entry.address.serverId) ?? [];
                group.push({ sessionId: entry.address.sessionId, patch: entry.patch });
                byHome.set(entry.address.serverId, group);
            }
            for (const [serverId, entries] of byHome) storage.getState().applyServerScopedSessionListRowPatches(serverId, entries);
        },
    });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    sessionRuntimeObservations.clear();
    storage.setState(initialState, true);
});

describe('createSessionListRenderableProjectionPatchCoalescer', () => {
    it('builds queued projections against each preceding admitted row and publishes one unique settlement', () => {
        seed(address, { hasPendingPermissionRequests: true, hasPendingUserActionRequests: false, pendingRequestObservedAt: 100 });
        const seenVersions: number[] = [];
        const queue = coalescer<SessionListRenderablePatchFields>((current, payload) => {
            seenVersions.push(current.agentStateVersion);
            return payload;
        });
        const notifications = countStoreNotifications(storage);
        try {
            queue.enqueue(address, { agentStateVersion: 3, hasPendingPermissionRequests: false,
                pendingRequestObservedAt: null }, { deferLeadingPatch: true });
            queue.enqueue(address, { agentStateVersion: 2, hasPendingPermissionRequests: true,
                pendingRequestObservedAt: 100 });
            queue.enqueue(address, { agentStateVersion: 4, hasPendingPermissionRequests: false,
                pendingRequestObservedAt: null });
            queue.flushAll();
            expect(seenVersions).toEqual([1, 3, 3]);
            expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId]).toMatchObject({
                agentStateVersion: 4, hasPendingPermissionRequests: false, pendingRequestObservedAt: null,
            });
            expect(notifications.read()).toHaveLength(1);
            expect(storage.getState().sessionListRenderableDelta?.changedSessionIds).toEqual([address.sessionId]);
        } finally { notifications.stop(); }
    });

    it('clears immediate-only leading-window state when a session id is dropped', () => {
        seed();
        const queue = coalescer<number>((_current, updatedAt) => ({ updatedAt }));
        const notifications = countStoreNotifications(storage);
        try {
            queue.enqueue(address, 2, { forceImmediate: true });
            expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId].updatedAt).toBe(2);
            queue.dropAddresses([address]);
            queue.enqueue(address, 3);
            expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId].updatedAt).toBe(3);
            expect(notifications.read()).toHaveLength(2);
        } finally { notifications.stop(); }
    });

    it('keeps all root, row, membership and index references when the final queued state is unchanged', () => {
        const original = seed();
        const previous = storage.getState();
        const queue = coalescer<SessionListRenderablePatchFields>((_current, payload) => payload);
        const notifications = countStoreNotifications(storage);
        try {
            queue.enqueue(address, { thinking: true, archivedAt: 10 }, { deferLeadingPatch: true });
            queue.enqueue(address, { thinking: false, archivedAt: null });
            vi.advanceTimersByTime(100);
            expect(notifications.read()).toEqual([]);
            expect(storage.getState()).toBe(previous);
            expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId]).toBe(original);
        } finally { notifications.stop(); }
    });

    it('keeps matching Session ids from different Homes in separate canonical publications', () => {
        const homeB = { serverId: 'server-b', sessionId: address.sessionId };
        seed();
        seed(homeB);
        const queue = coalescer<number>((_current, updatedAt) => ({ updatedAt }));
        queue.enqueue(address, 2, { deferLeadingPatch: true });
        queue.enqueue(homeB, 3, { deferLeadingPatch: true });
        vi.advanceTimersByTime(100);
        expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId].updatedAt).toBe(2);
        expect(storage.getState().sessionListRowsByServerId[homeB.serverId][homeB.sessionId].updatedAt).toBe(3);
    });

    it('does not erase a queued carrier clock before the canonical owner sees a newer presence row', () => {
        seed(address, { activeAt: 100, updatedAt: 100, presence: 'online' });
        const queue = coalescer<SessionListRenderablePatchFields>((_current, payload) => payload);
        queue.enqueue(address, { activeAt: 120, updatedAt: 120 }, { deferLeadingPatch: true });
        sessionRuntimeObservations.observe(address, { active: false, activeAt: 123, presence: 123 });
        storage.getState().applyServerScopedSessionListRowPatches(address.serverId,
            [{ sessionId: address.sessionId, patch: { active: false, activeAt: 123, presence: 123 } }]);
        sessionRuntimeObservations.observe(address, { active: true, activeAt: 124, presence: 'online' });
        storage.getState().applyServerScopedSessionListRowPatches(address.serverId,
            [{ sessionId: address.sessionId, patch: { active: true, activeAt: 124, presence: 'online' } }]);
        const previous = storage.getState();
        const notifications = countStoreNotifications(storage);
        try {
            queue.flushAll();
            expect(notifications.read()).toEqual([]);
            expect(storage.getState()).toBe(previous);
            expect(sessionRuntimeObservations.read(address)).toMatchObject({ activeAt: 124, presence: 'online', fullPublicationUpdatedAt: 120 });
        } finally { notifications.stop(); }
    });

    it('rechecks operation lifetime before building or applying a queued projection', () => {
        const original = seed();
        let current = true;
        const queue = coalescer<number>((_row, updatedAt) => ({ updatedAt }));
        queue.enqueue(address, 2, { deferLeadingPatch: true, shouldContinue: () => current });
        current = false;
        const notifications = countStoreNotifications(storage);
        try {
            queue.flushAll();
            expect(notifications.read()).toEqual([]);
            expect(storage.getState().sessionListRowsByServerId[address.serverId][address.sessionId]).toBe(original);
        } finally { notifications.stop(); }
    });
});
