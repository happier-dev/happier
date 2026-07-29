import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useAgentCliInstallQueue } from './useAgentCliInstallQueue';

const capabilitiesState = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...original,
        machineCapabilitiesInvoke: capabilitiesState.invoke,
    };
});

describe('useAgentCliInstallQueue', () => {
    beforeEach(() => {
        capabilitiesState.invoke.mockReset();
    });

    it('runs installs sequentially and continues after failures', async () => {
        capabilitiesState.invoke
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } })
            .mockResolvedValueOnce({ supported: true, response: { ok: false, error: { message: 'boom' }, logPath: '/tmp/claude.log' } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useAgentCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            agentIds: ['codex', 'claude', 'gemini'],
            agentDetectKeys: { codex: 'codex', claude: 'claude', gemini: 'gemini' },
            installedByAgentId: { codex: false, claude: false, gemini: false },
        }));

        let summary: { installedAgentIds: string[]; failedAgentIds: string[] } | null = null;
        await act(async () => {
            summary = await hook.getCurrent().start();
        });

        expect(summary).toEqual({
            installedAgentIds: ['codex', 'gemini'],
            failedAgentIds: ['claude'],
        });
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(3);
        expect(capabilitiesState.invoke.mock.calls.map((call) => call[1]?.id)).toEqual(['cli.codex', 'cli.claude', 'cli.gemini']);

        expect(hook.getCurrent().resolveStatus('codex').status).toBe('installed');
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('failed');
        expect(hook.getCurrent().resolveStatus('gemini').status).toBe('installed');
    });

    it('can retry a failed provider without rerunning the full queue', async () => {
        capabilitiesState.invoke
            .mockResolvedValueOnce({ supported: true, response: { ok: false, error: { message: 'boom' } } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useAgentCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            agentIds: ['claude'],
            agentDetectKeys: { claude: 'claude' },
            installedByAgentId: { claude: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('failed');

        await act(async () => {
            await hook.getCurrent().retry('claude');
        });
        expect(hook.getCurrent().resolveStatus('claude').status).toBe('installed');
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(2);
    });

    it('invokes provider capability ids instead of binary detect keys', async () => {
        capabilitiesState.invoke.mockResolvedValue({ supported: true, response: { ok: true, result: null } });

        const hook = await renderHook(() => useAgentCliInstallQueue({
            machineId: 'machine-1',
            serverId: 'server-a',
            agentIds: ['antigravity', 'ohMyPi'],
            agentDetectKeys: { antigravity: 'agy', ohMyPi: 'omp' },
            installedByAgentId: { antigravity: false, ohMyPi: false },
        }));

        await act(async () => {
            await hook.getCurrent().start();
        });

        expect(capabilitiesState.invoke.mock.calls.map((call) => call[1]?.id)).toEqual([
            'cli.antigravity',
            'cli.ohMyPi',
        ]);
    });
});
