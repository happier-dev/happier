import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { storage } from '@/sync/domains/state/storageStore';
import { useMachineSetupStepSatisfied } from './useMachineSetupStepSatisfied';

afterEach(() => {
    standardCleanup();
});

function machineFixture(overrides: Readonly<{ id: string; active?: boolean; revokedAt?: number | null }>): Record<string, unknown> {
    return {
        id: overrides.id,
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: overrides.active ?? false,
        activeAt: 1000,
        metadata: { host: overrides.id, platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: overrides.revokedAt ?? null,
    };
}

describe('useMachineSetupStepSatisfied', () => {
    it('is unsatisfied while the account has zero machines', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useMachineSetupStepSatisfied(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('is satisfied by a single OFFLINE machine (online state is irrelevant)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-offline': machineFixture({ id: 'm-offline', active: false }) as never,
                },
                machineListByServerId: {},
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useMachineSetupStepSatisfied(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('ignores revoked machines (a revoked-only account still needs machine setup)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-revoked': machineFixture({ id: 'm-revoked', revokedAt: 1700000000000 }) as never,
                },
                machineListByServerId: {},
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useMachineSetupStepSatisfied(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
