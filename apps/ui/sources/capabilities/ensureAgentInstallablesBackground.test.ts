import { describe, expect, it, vi } from 'vitest';

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { CapabilitiesInvokeRequest, MachineCapabilitiesInvokeResult } from '@/sync/ops';

import { ensureAgentInstallablesBackground } from './ensureAgentInstallablesBackground';

describe('ensureAgentInstallablesBackground', () => {
    it('prefetches missing dep status before planning background installs', async () => {
        const settings = settingsParse({});

        let snapshotResults: MachineCapabilitiesSnapshot['response']['results'] = {};

        const prefetchMachineCapabilities = vi.fn(async (params: {
            request: CapabilitiesDetectRequest;
        }) => {
            const reqs = Array.isArray(params.request?.requests) ? params.request.requests : [];
            const askedForCodexAcp = reqs.some((r) => r.id === 'dep.codex-acp');
            if (askedForCodexAcp) {
                snapshotResults = {
                    ...snapshotResults,
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                };
            }
        });

        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(
            (): MachineCapabilitiesSnapshot => ({
                response: { protocolVersion: 1 as const, results: snapshotResults },
            }),
        );

        await ensureAgentInstallablesBackground(
            {
                agentId: 'codex',
                machineId: 'm1',
                serverId: 's1',
                settings,
                resumeSessionId: '',
            },
            {
                prefetchMachineCapabilities,
                getMachineCapabilitiesSnapshot,
                machineCapabilitiesInvoke,
            },
        );

        expect(prefetchMachineCapabilities).toHaveBeenCalled();
        expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ id: 'dep.codex-acp', method: 'install' }),
            expect.anything(),
        );
    });

    it('respects autoInstallWhenNeeded=false policy overrides', async () => {
        const settings = settingsParse({
            installablesPolicyByMachineId: {
                m1: {
                    'codex-acp': { autoInstallWhenNeeded: false },
                },
            },
        } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: {
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                },
            },
        }));

        await ensureAgentInstallablesBackground(
            {
                agentId: 'codex',
                machineId: 'm1',
                serverId: 's1',
                settings,
                resumeSessionId: '',
            },
            {
                prefetchMachineCapabilities,
                getMachineCapabilitiesSnapshot,
                machineCapabilitiesInvoke,
            },
        );

        expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
    });

    it('does not pass invalid codexAcpInstallSpec values to dep install invocations', async () => {
        const settings = settingsParse({
            codexAcpInstallSpec: 'not a valid spec',
        } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: {
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                },
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_installSpec', serverId: 's_installSpec', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        const request = machineCapabilitiesInvoke.mock.calls[0]?.[1];
        expect(request).toMatchObject({ id: 'dep.codex-acp', method: 'install' });
        expect((request as any).params).toBeUndefined();
    });

    it('passes valid codexAcpInstallSpec values to dep install invocations', async () => {
        const settings = settingsParse({
            codexAcpInstallSpec: '@zed-industries/codex-acp@0.0.0-test',
        } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: {
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                },
            },
        }));

        await ensureAgentInstallablesBackground(
            {
                agentId: 'codex',
                machineId: 'm_installSpec_valid',
                serverId: 's_installSpec_valid',
                settings,
                resumeSessionId: '',
            },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        const request = machineCapabilitiesInvoke.mock.calls[0]?.[1];
        expect(request).toMatchObject({
            id: 'dep.codex-acp',
            method: 'install',
            params: { installSpec: '@zed-industries/codex-acp@0.0.0-test' },
        });
    });

    it('does not suppress retries after a successful invoke when installSpec changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        try {
            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(
                async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                    return { supported: true, response: { ok: true, result: null } };
                },
            );

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: {
                        'dep.codex-acp': {
                            ok: true as const,
                            checkedAt: Date.now(),
                            data: {
                                installed: false,
                                installDir: '/tmp',
                                binPath: null,
                                installedVersion: null,
                                distTag: 'latest',
                                lastInstallLogPath: null,
                            },
                        },
                    },
                },
            }));

            const settings1 = settingsParse({ codexAcpInstallSpec: '@zed-industries/codex-acp@0.0.0-test' } as any);
            const settings2 = settingsParse({ codexAcpInstallSpec: '@zed-industries/codex-acp@0.0.1-test' } as any);

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_spec_change', serverId: 's_spec_change', settings: settings1, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_spec_change', serverId: 's_spec_change', settings: settings2, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
            expect(machineCapabilitiesInvoke.mock.calls[0]?.[1]).toMatchObject({
                id: 'dep.codex-acp',
                method: 'install',
                params: { installSpec: '@zed-industries/codex-acp@0.0.0-test' },
            });
            expect(machineCapabilitiesInvoke.mock.calls[1]?.[1]).toMatchObject({
                id: 'dep.codex-acp',
                method: 'install',
                params: { installSpec: '@zed-industries/codex-acp@0.0.1-test' },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not permanently suppress retries after a failed invoke', async () => {
        const settings = settingsParse({});

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: {
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                },
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_retry', serverId: 's_retry', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );
        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_retry', serverId: 's_retry', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
    });

    it('does not permanently suppress retries after a non-ok invoke response', async () => {
        const settings = settingsParse({});

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockResolvedValueOnce({ supported: true, response: { ok: false, errorMessage: 'nope' } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: {
                    'dep.codex-acp': {
                        ok: true as const,
                        checkedAt: Date.now(),
                        data: {
                            installed: false,
                            installDir: '/tmp',
                            binPath: null,
                            installedVersion: null,
                            distTag: 'latest',
                            lastInstallLogPath: null,
                        },
                    },
                },
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_nonok', serverId: 's_nonok', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );
        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_nonok', serverId: 's_nonok', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
    });

    it('retries after a successful invoke if the dep is still missing later', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        try {
            const settings = settingsParse({});

            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(async () => {
                return { supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult;
            });

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: {
                        'dep.codex-acp': {
                            ok: true as const,
                            checkedAt: Date.now(),
                            data: {
                                installed: false,
                                installDir: '/tmp',
                                binPath: null,
                                installedVersion: null,
                                distTag: 'latest',
                                lastInstallLogPath: null,
                            },
                        },
                    },
                },
            }));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
