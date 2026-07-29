import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { machineScmLogList } from '@/sync/ops/scm/machineScm';

type MachineScmLogList = typeof machineScmLogList;

const machineScmLogListSpy = vi.fn<MachineScmLogList>(async () => ({
    success: true,
    entries: [],
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmLogList: (...args: Parameters<MachineScmLogList>) => machineScmLogListSpy(...args),
}));

describe('useWorkspaceScmCommitHistory', () => {
    beforeEach(() => {
        machineScmLogListSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps workspace server scope when loading commit history', async () => {
        const { useWorkspaceScmCommitHistory } = await import('./useWorkspaceScmCommitHistory');
        const hook = await renderHook(() => useWorkspaceScmCommitHistory({
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
            readLogEnabled: true,
        }));

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        expect(machineScmLogListSpy).toHaveBeenCalledWith(
            'machine-a',
            {
                cwd: '/repo',
                limit: 50,
                skip: 0,
            },
            { serverId: 'server-a' },
        );
    });
});
