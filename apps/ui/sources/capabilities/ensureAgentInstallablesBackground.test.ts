import { describe, expect, it, vi } from 'vitest';

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { CapabilitiesDetectRequest, CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { MachineCapabilitiesInvokeResult } from '@/sync/ops';

import { buildInstallablesBackgroundActionKey, ensureAgentInstallablesBackground } from './ensureAgentInstallablesBackground';

function buildMissingCodexAcpResults() {
    return {
        'dep.codex-acp': {
            ok: true as const,
            checkedAt: Date.now(),
            data: {
                installed: false,
                installDir: '/tmp',
                binPath: null,
                installedVersion: null,
                sourceKind: 'github_release_binary' as const,
                lastInstallLogPath: null,
            },
        },
    };
}

async function withMockedNow<T>(initialNowMs: number, run: (setNowMs: (nextNowMs: number) => void) => Promise<T>): Promise<T> {
    let currentNowMs = initialNowMs;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentNowMs);
    try {
        return await run((nextNowMs) => {
            currentNowMs = nextNowMs;
        });
    } finally {
        nowSpy.mockRestore();
    }
}

describe('ensureAgentInstallablesBackground', () => {
    it('prefetches missing dep status before planning background installs', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        let snapshotResults: MachineCapabilitiesSnapshot['response']['results'] = {};

        const prefetchMachineCapabilities = vi.fn(async (params: {
            request: CapabilitiesDetectRequest;
        }) => {
            const reqs = Array.isArray(params.request?.requests) ? params.request.requests : [];
            const askedForCodexAcp = reqs.some((r) => r.id === 'dep.codex-acp');
            if (askedForCodexAcp) {
                snapshotResults = buildMissingCodexAcpResults();
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
            codexBackendMode: 'acp',
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
                results: buildMissingCodexAcpResults(),
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

    it('invokes background installs without managed install override params', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi.fn(
            async (_machineId: string, _request: CapabilitiesInvokeRequest): Promise<MachineCapabilitiesInvokeResult> => {
                return { supported: true, response: { ok: true, result: null } };
            },
        );

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
            },
        }));

        await ensureAgentInstallablesBackground(
            { agentId: 'codex', machineId: 'm_install', serverId: 's_install', settings, resumeSessionId: '' },
            { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
        );

        expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        const request = machineCapabilitiesInvoke.mock.calls[0]?.[1];
        expect(request).toMatchObject({ id: 'dep.codex-acp', method: 'install' });
        expect((request as any).params).toBeUndefined();
    });

    it('suppresses duplicate retries during the success cooldown window', async () => {
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);
            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(
                async (): Promise<MachineCapabilitiesInvokeResult> => ({ supported: true, response: { ok: true, result: null } }),
            );

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_cooldown', serverId: 's_cooldown', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_cooldown', serverId: 's_cooldown', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
        });
    });

    it('includes invoke params in the cooldown key', () => {
        const previewInstallRequest: CapabilitiesInvokeRequest = {
            id: 'dep.codex-acp',
            method: 'install',
            params: { channel: 'preview' },
        };
        const base = buildInstallablesBackgroundActionKey({
            machineId: 'm_key',
            serverId: 's_key',
            installableKey: 'codex-acp',
            request: { id: 'dep.codex-acp', method: 'install' },
        });
        const withParams = buildInstallablesBackgroundActionKey({
            machineId: 'm_key',
            serverId: 's_key',
            installableKey: 'codex-acp',
            request: previewInstallRequest,
        });

        expect(withParams).not.toBe(base);
    });

    it('does not permanently suppress retries after a failed invoke', async () => {
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
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
        const settings = settingsParse({ codexBackendMode: 'acp' } as any);

        const prefetchMachineCapabilities = vi.fn(async () => {});
        const machineCapabilitiesInvoke = vi
            .fn()
            .mockResolvedValueOnce({ supported: true, response: { ok: false, errorMessage: 'nope' } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

        const getMachineCapabilitiesSnapshot = vi.fn(() => ({
            response: {
                protocolVersion: 1 as const,
                results: buildMissingCodexAcpResults(),
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
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);

            const prefetchMachineCapabilities = vi.fn(async () => {});
            const machineCapabilitiesInvoke = vi.fn(async () => {
                return { supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult;
            });

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            setNowMs(Date.parse('2026-01-01T01:00:00.000Z'));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_ok_retry', serverId: 's_ok_retry', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
        });
    });

    it('retries after an in-flight block ages out', async () => {
        await withMockedNow(Date.parse('2026-01-01T00:00:00.000Z'), async (setNowMs) => {
            const settings = settingsParse({ codexBackendMode: 'acp' } as any);
            const prefetchMachineCapabilities = vi.fn(async () => {});
            let resolveInvoke: (() => void) | null = null;
            const machineCapabilitiesInvoke = vi
                .fn()
                .mockImplementationOnce(
                    async () => await new Promise<MachineCapabilitiesInvokeResult>((resolve) => {
                        resolveInvoke = () => resolve({ supported: true, response: { ok: true, result: null } });
                    }),
                )
                .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } } satisfies MachineCapabilitiesInvokeResult);

            const getMachineCapabilitiesSnapshot = vi.fn(() => ({
                response: {
                    protocolVersion: 1 as const,
                    results: buildMissingCodexAcpResults(),
                },
            }));

            const firstCall = ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_stale', serverId: 's_stale', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            await vi.waitFor(() => {
                expect(resolveInvoke).not.toBeNull();
            });
            setNowMs(Date.parse('2026-01-01T00:06:00.000Z'));

            await ensureAgentInstallablesBackground(
                { agentId: 'codex', machineId: 'm_stale', serverId: 's_stale', settings, resumeSessionId: '' },
                { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot, machineCapabilitiesInvoke },
            );

            const completeInvoke = resolveInvoke as (() => void) | null;
            if (!completeInvoke) {
                throw new Error('expected install invoke to remain pending');
            }
            completeInvoke();
            await firstCall;

            expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(2);
        });
    });
});
