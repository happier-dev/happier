import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';

const machineCapabilitiesDetectMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        machineCapabilitiesDetect: machineCapabilitiesDetectMock,
    };
});

import { useProviderReadiness } from './useProviderReadiness';

afterEach(() => {
    standardCleanup();
    machineCapabilitiesDetectMock.mockReset();
});

describe('useProviderReadiness', () => {
    it('projects provider CLI capability results into ready, missing, and unknown pills', async () => {
        const previousState = storage.getState();
        const now = Date.now();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-connected': createMachineFixture({
                        id: 'm-connected',
                        active: true,
                        activeAt: now,
                        updatedAt: now,
                        daemonStateVersion: 1,
                    }),
                },
            }));
            machineCapabilitiesDetectMock.mockImplementation(async (_machineId: string, request: CapabilitiesDetectRequest) => ({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.claude': { ok: true, checkedAt: now, data: { available: true } },
                        'cli.codex': { ok: true, checkedAt: now, data: { available: false } },
                    },
                },
            }));

            const hook = await renderHook(() => useProviderReadiness({
                machineId: 'm-connected',
                providerIds: ['claude', 'codex', 'gemini'],
                serverId: 'server-a',
            }), {
                flushOptions: { cycles: 4, turns: 8 },
            });

            expect(machineCapabilitiesDetectMock).toHaveBeenCalledWith(
                'm-connected',
                expect.objectContaining({
                    requests: expect.arrayContaining([
                        expect.objectContaining({ id: 'cli.claude' }),
                        expect.objectContaining({ id: 'cli.codex' }),
                        expect.objectContaining({ id: 'cli.gemini' }),
                    ]),
                }),
                expect.objectContaining({ serverId: 'server-a' }),
            );
            expect(hook.getCurrent()).toEqual([
                { providerId: 'claude', status: 'ready' },
                { providerId: 'codex', status: 'missing' },
                { providerId: 'gemini', status: 'unknown' },
            ]);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not probe and returns unknown while the machine is disconnected', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
            }));

            const hook = await renderHook(() => useProviderReadiness({
                machineId: null,
                providerIds: ['claude'],
            }), {
                flushOptions: { cycles: 2, turns: 4 },
            });

            expect(machineCapabilitiesDetectMock).not.toHaveBeenCalled();
            expect(hook.getCurrent()).toEqual([{ providerId: 'claude', status: 'unknown' }]);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
