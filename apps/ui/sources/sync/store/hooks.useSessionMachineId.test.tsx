import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useSessionMachineId } from './hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'session-machine-id-hook';

function seedSession(patch: Record<string, unknown>): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [SESSION_ID]: {
                id: SESSION_ID,
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                thinking: false,
                presence: 'online',
                metadata: null,
                agentState: null,
                agentStateVersion: 0,
                ...patch,
            } as never,
        },
    }));
}

/**
 * One hook answers "which machine hosts this session", and it answers it through
 * the metadata-layout owner. `machineId` is an OWNER key: a layout-v1 session's
 * shared `metadata` cannot carry it, so a reader that indexes raw `metadata` is
 * not a narrower version of this hook — it is a different, wrong answer.
 */
describe('useSessionMachineId', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('reads the owner projection under layout v1, where the shared metadata has no machine id', async () => {
        seedSession({
            metadataLayoutVersion: 1,
            metadata: { v: 1 },
            ownerMetadataView: { path: '/w', machineId: 'machine-owner' },
        });

        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBe('machine-owner');
    });

    it('still reads plain metadata under layout 0, which is the same object the owner view returns', async () => {
        seedSession({ metadata: { path: '/w', machineId: 'machine-plain' } });

        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBe('machine-plain');
    });

    /**
     * A layout this build cannot read is not a session with no machine — but it is
     * a session whose metadata this build must not index by hand, so the answer is
     * "unknown", not a field scavenged out of a shape it does not understand.
     */
    it('answers null for a metadata layout this build cannot read', async () => {
        seedSession({
            metadataLayoutVersion: 2,
            metadata: { machineId: 'machine-from-unknown-layout' },
            ownerMetadataView: { machineId: 'machine-from-unknown-layout' },
        });

        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBeNull();
    });

    it('answers null when the session record is absent', async () => {
        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBeNull();
    });
});
