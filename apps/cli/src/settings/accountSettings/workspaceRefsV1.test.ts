import { describe, expect, it } from 'vitest';

import type { AccountSettings } from '@happier-dev/protocol';

import { resolveWorkspaceRefForMachineRoot } from './workspaceRefsV1';

describe('workspace ref resolution', () => {
    it('resolves one canonical workspace identity from machine and normalized root', () => {
        const refs: AccountSettings['workspaceRefsV1'] = [
            { id: 'workspace_a', serverId: 'server_a', machineId: 'machine_a', rootPath: 'C:\\Repo\\', createdAtMs: 1 },
            { id: 'workspace_b', serverId: 'server_b', machineId: 'machine_b', rootPath: '/repo', createdAtMs: 1 },
        ];
        expect(resolveWorkspaceRefForMachineRoot(refs, { machineId: 'machine_a', rootPath: 'c:/repo' }))
            .toEqual(refs[0]);
        expect(resolveWorkspaceRefForMachineRoot([
            ...refs,
            { ...refs[0]!, id: 'ambiguous', serverId: 'server_other' },
        ], { machineId: 'machine_a', rootPath: 'c:/repo' })).toBeNull();
    });
});
