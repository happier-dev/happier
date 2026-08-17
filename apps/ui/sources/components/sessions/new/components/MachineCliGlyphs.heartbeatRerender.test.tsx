import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installMachineComponentCommonModuleMocks } from '@/components/machines/machineComponentTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';

import { MachineCliGlyphs } from './MachineCliGlyphs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMachineComponentCommonModuleMocks();

// `machineCapabilitiesDetect` is the per-machine daemon RPC boundary. Everything below it —
// the module-level capabilities cache, the daemon-scoped cache key, the real machine store —
// runs for real so this measures the row's actual subscription scope.
vi.mock('@/sync/ops', () => ({
    machineCapabilitiesDetect: vi.fn(async () => ({
        supported: true,
        response: { protocolVersion: 1, results: {} },
    })),
}));

const MACHINE_ID = 'm-heartbeat';
const SERVER_ID = 'server-a';

function seedMachine(activeAt: number, daemonStateVersion: number) {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        machines: {
            ...state.machines,
            [MACHINE_ID]: {
                id: MACHINE_ID,
                seq: 1,
                createdAt: activeAt,
                updatedAt: activeAt,
                active: true,
                activeAt,
                metadata: {
                    host: 'heartbeat-host',
                    platform: 'darwin',
                    happyCliVersion: '1',
                    happyHomeDir: '.happy',
                    homeDir: '/home',
                },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion,
                revokedAt: null,
            },
        },
    }));
}

afterEach(() => {
    standardCleanup();
});

describe('MachineCliGlyphs machine-store subscription scope', () => {
    it('does not re-render a machine row when a heartbeat changes fields the glyphs never read', async () => {
        const previousState = storage.getState();
        try {
            const activeAt = Date.now();
            seedMachine(activeAt, 7);

            let commits = 0;
            const screen = await renderScreen(
                React.createElement(
                    React.Profiler,
                    {
                        id: 'machine-cli-glyphs',
                        onRender: () => {
                            commits += 1;
                        },
                    },
                    React.createElement(MachineCliGlyphs, {
                        machineId: MACHINE_ID,
                        serverId: SERVER_ID,
                        isOnline: true,
                    }),
                ),
            );
            await flushHookEffects({ cycles: 2, turns: 4 });

            const committedAfterMount = commits;

            // A presence heartbeat: only `activeAt`/`updatedAt`/`seq` move. `daemonStateVersion`
            // — the only machine field the CLI glyph row consumes — is unchanged, so the row has
            // nothing new to paint and must not re-render.
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        ...state.machines,
                        [MACHINE_ID]: {
                            ...state.machines[MACHINE_ID]!,
                            seq: 2,
                            updatedAt: activeAt + 1000,
                            activeAt: activeAt + 1000,
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 2, turns: 4 });

            expect(commits - committedAfterMount).toBe(0);

            await screen.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('still re-renders when the machine daemon state version changes', async () => {
        const previousState = storage.getState();
        try {
            const activeAt = Date.now();
            seedMachine(activeAt, 7);

            let commits = 0;
            const screen = await renderScreen(
                React.createElement(
                    React.Profiler,
                    {
                        id: 'machine-cli-glyphs',
                        onRender: () => {
                            commits += 1;
                        },
                    },
                    React.createElement(MachineCliGlyphs, {
                        machineId: MACHINE_ID,
                        serverId: SERVER_ID,
                        isOnline: true,
                    }),
                ),
            );
            await flushHookEffects({ cycles: 2, turns: 4 });

            const committedAfterMount = commits;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        ...state.machines,
                        [MACHINE_ID]: {
                            ...state.machines[MACHINE_ID]!,
                            daemonStateVersion: 8,
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 2, turns: 4 });

            expect(commits - committedAfterMount).toBeGreaterThan(0);

            await screen.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
