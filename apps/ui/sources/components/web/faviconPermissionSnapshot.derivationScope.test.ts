import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { createFaviconPermissionSnapshotSelector } from './faviconPermissionSnapshot';

const SESSION_COUNT = 40;

/**
 * The favicon indicator is mounted at the web app root, so its selector runs on
 * every store notification. `thinkingAt` is read by every derivation path in the
 * selector, so counting reads of it measures how many sessions the selector
 * actually re-derives on a wave: a wave that moved nothing must cost nothing,
 * and a wave that moved one session must not pay for the whole account.
 */
function createTrackedSession(id: string, onFieldRead: (id: string) => void): Session {
    const session = {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
    } as unknown as Session;
    Object.defineProperty(session, 'thinkingAt', {
        configurable: true,
        enumerable: true,
        get: () => {
            onFieldRead(id);
            return 0;
        },
    });
    return session;
}

function createState(sessions: Record<string, Session>): StorageState {
    return createStorageStoreMock({ sessions, sessionMessages: {} }).getState();
}

describe('createFaviconPermissionSnapshotSelector derivation scope', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('costs nothing when a store notification moved none of its inputs', () => {
        const reads: string[] = [];
        const sessions: Record<string, Session> = {};
        for (let index = 0; index < SESSION_COUNT; index += 1) {
            const id = `session-${index}`;
            sessions[id] = createTrackedSession(id, (readId) => reads.push(readId));
        }
        const state = createState(sessions);
        const selector = createFaviconPermissionSnapshotSelector();

        selector(state);
        reads.length = 0;

        const second = selector(state);

        expect(reads).toEqual([]);
        expect(second.hasFreshPermission).toBe(false);
    });

    it('re-derives only the sessions that moved', () => {
        const reads: string[] = [];
        const sessions: Record<string, Session> = {};
        for (let index = 0; index < SESSION_COUNT; index += 1) {
            const id = `session-${index}`;
            sessions[id] = createTrackedSession(id, (readId) => reads.push(readId));
        }
        const state = createState(sessions);
        const selector = createFaviconPermissionSnapshotSelector();

        selector(state);
        reads.length = 0;

        const movedId = 'session-7';
        const nextSessions = {
            ...sessions,
            [movedId]: createTrackedSession(movedId, (readId) => reads.push(readId)),
        };
        selector(createState(nextSessions));

        expect([...new Set(reads)]).toEqual([movedId]);
    });
});
