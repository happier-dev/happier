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
 * `resolveSessionMachineId`. A caller that indexes `metadata.machineId` by hand is
 * not a narrower version of this — it silently drops the linked direct session,
 * whose machine is the only one such a session has.
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

    it('reads the session machine id off metadata', async () => {
        seedSession({ metadata: { path: '/w', machineId: ' machine-plain ' } });

        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBe('machine-plain');
    });

    it('falls back to the linked direct session, which has no top-level machine id', async () => {
        seedSession({
            metadata: {
                path: '/w',
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine-direct',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            },
        });

        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBe('machine-direct');
    });

    it('answers null when the session record is absent', async () => {
        const hook = await renderHook(() => useSessionMachineId(SESSION_ID));

        expect(hook.getCurrent()).toBeNull();
    });
});
