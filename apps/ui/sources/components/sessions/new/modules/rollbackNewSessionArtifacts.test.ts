import { describe, expect, it, vi } from 'vitest';

import { rollbackNewSessionArtifacts } from './rollbackNewSessionArtifacts';

describe('rollbackNewSessionArtifacts', () => {
    it('removes created worktrees through argv-based machine RPC payloads without touching workspace artifacts', async () => {
        const machineBash = vi.fn().mockResolvedValue({ success: true, stderr: '' });

        await rollbackNewSessionArtifacts({
            machineId: 'machine-1',
            selectedPath: 'C:/repo',
            actualPath: 'C:/repo/.dev/worktree/feature branch',
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature/auth', baseRef: 'main' },
            serverId: 'server-b',
            machineBash,
        });

        expect(machineBash).toHaveBeenCalledWith(
            'machine-1',
            {
                argv: ['git', 'worktree', 'remove', '--force', '--', 'C:/repo/.dev/worktree/feature branch'],
            },
            'C:/repo',
            { serverId: 'server-b' },
        );
    });
});
