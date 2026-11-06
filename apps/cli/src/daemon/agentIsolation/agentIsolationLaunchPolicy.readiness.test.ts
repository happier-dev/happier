import { expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { admitAgentIsolationLaunchForHost, assertHostRequesterExecutionAdmissionForHost } from './agentIsolationLaunchPolicy';

it.skipIf(process.platform !== 'linux').each([
    { kind: 'applying', phase: 'workspace' },
    { kind: 'enable_required', reason: 'existing_machine_workspace_migration' },
    { kind: 'disabled' },
] as const)('reports the actual $kind readiness state at native admission', async status => {
    const identity = { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
    const snapshot = { enabled: true, status, workspaceRoots: [] };
    const details = { reason: 'isolation_not_ready', status: status.kind,
        ...(status.kind === 'applying' ? { phase: status.phase } : {}) };
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    try {
        expect(() => assertHostRequesterExecutionAdmissionForHost({ identity, snapshot, agentLaunchKind: 'exec' }))
            .toThrow(expect.objectContaining({ code: 'agent_isolation_unavailable', details: expect.objectContaining(details) }));
        await expect(admitAgentIsolationLaunchForHost({ requesterIdentity: identity, context: { read: () => snapshot },
            cwd: process.cwd(), agentLaunchKind: 'exec' }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details });
        expect(diagnostic).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
            reason: 'isolation_not_ready', status: status.kind,
            ...(status.kind === 'applying' ? { isolationPhase: status.phase } : {}),
        }));
    } finally { diagnostic.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('preserves a native probe failure as an unavailable reason', async () => {
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
    const snapshot = { enabled: true, status: { kind: 'unavailable', code: 'launch_probe_failed' } as const, workspaceRoots: [] };
    const details = { reason: 'launch_probe_failed', status: 'unavailable' };
    expect(() => assertHostRequesterExecutionAdmissionForHost({ identity: requesterIdentity, snapshot, agentLaunchKind: 'exec' }))
        .toThrow(expect.objectContaining({ code: 'agent_isolation_unavailable', details: expect.objectContaining(details) }));
    await expect(admitAgentIsolationLaunchForHost({ requesterIdentity, context: { read: () => snapshot },
        cwd: process.cwd(), agentLaunchKind: 'exec' }))
        .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details });
});
