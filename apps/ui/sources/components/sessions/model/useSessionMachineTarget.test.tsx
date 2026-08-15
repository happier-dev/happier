import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useSessionMachineControlTarget } from './useSessionMachineTarget';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
});

describe('useSessionMachineControlTarget', () => {
    it('drops a metadata-direct target when only machine inventory changes to known inactive', async () => {
        const previousState = storage.getState();
        try {
            const session = {
                id: 'session-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                presence: 'offline',
                metadata: {
                    machineId: 'machine-1',
                    path: '/workspace/repo',
                },
            };
            storage.setState((state) => ({
                ...state,
                sessions: { 'session-1': session as any },
                machines: {},
                machineDisplayById: {},
                getProjectForSession: () => null,
            }));

            const seen: Array<ReturnType<typeof useSessionMachineControlTarget>> = [];
            const hook = await renderHook(() => {
                const value = useSessionMachineControlTarget('session-1');
                React.useEffect(() => {
                    seen.push(value);
                }, [value]);
                return value;
            }, { flushOptions: { cycles: 1, turns: 4 } });

            expect(hook.getCurrent()).toMatchObject({
                machineId: 'machine-1',
                basePath: '/workspace/repo',
                confidence: 'metadata_direct',
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        'machine-1': {
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 1,
                            updatedAt: 2,
                            active: false,
                            activeAt: 1,
                            metadata: {
                                host: 'workstation.local',
                                platform: 'darwin',
                                happyCliVersion: '1',
                                happyHomeDir: '/tmp/.happy',
                                homeDir: '/Users/test',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            revokedAt: null,
                        } as any,
                    },
                }));
            });
            await flushHookEffects({ cycles: 2, turns: 4 });

            expect(storage.getState().sessions['session-1']).toBe(session);
            expect(hook.getCurrent()).toBeNull();
            expect(seen.at(-1)).toBeNull();

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
