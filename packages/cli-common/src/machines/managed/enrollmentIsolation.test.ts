import { expect, it } from 'vitest';
import type { MachineAgentIsolationPolicyV1, MachineAgentIsolationStatusV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { applyManagedMachineEnrollmentIsolation, type ManagedEnrollmentIsolationRequest } from './enrollmentIsolation.js';

it.each(['conflict', 'plan_changed'] as const)('retains %s facts without native plan contents', async kind => {
    const preview = { kind: 'ready', policy: { enabled: false }, metadataVersion: 4, status: { kind: 'disabled' },
        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: true, planDigest: 'reviewed' } };
    const current = { ...preview, policy: { enabled: true, memberProvisioning: 'linuxUsersV1' }, metadataVersion: 5,
        plan: { ...preview.plan, roots: [{ rootId: 'private-root', path: '/private/workspace', changes: [] }], planDigest: 'changed' } };
    const failure = await applyManagedMachineEnrollmentIsolation({ target: { machineId: 'guest' }, policy: { enabled: true },
        // The guest response is the transport boundary. Projection and policy comparison stay real.
        dispatch: async request => request.actionId === 'machines.agentIsolation.preview' ? preview
            : kind === 'conflict' ? { kind, policy: current.policy, metadataVersion: current.metadataVersion } : { kind, current },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: kind, details: { kind: 'managedAgentIsolation', phase: 'machines.agentIsolation.set',
        code: kind, expectedMetadataVersion: 4, metadataVersion: 5, expectedPolicy: preview.policy, policy: current.policy } });
    expect(JSON.stringify(failure)).not.toContain('/private/workspace');
});

it.each([
    { name: 'effective shared Agent', policy: { enabled: true }, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, writes: 0 },
    { name: 'already disabled', policy: { enabled: false }, status: { kind: 'disabled' }, writes: 0 },
    { name: 'unavailable equal policy', policy: { enabled: true }, status: { kind: 'unavailable', code: 'provisioning_unavailable' }, writes: 1 },
    { name: 'member policy differs', policy: { enabled: true, memberProvisioning: 'linuxUsersV1' }, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, writes: 1 },
] satisfies { name: string; policy: MachineAgentIsolationPolicyV1; status: MachineAgentIsolationStatusV1; writes: number }[])(
    'bootstrap $name requests only necessary isolation changes', async ({ policy, status, writes }) => {
        const requests: ManagedEnrollmentIsolationRequest[] = [];
        // The guest Action transport is the system boundary; policy matching stays real.
        await applyManagedMachineEnrollmentIsolation({ target: { serverId: 'home', machineId: 'guest' }, policy,
            dispatch: async request => {
                requests.push(request);
                if (request.actionId === 'machines.agentIsolation.preview') return { kind: 'ready',
                    policy: { enabled: policy.enabled }, metadataVersion: 17, status,
                    plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'review' } };
                return { kind: 'accepted', metadataVersion: 18, operationId: 'change', status: { kind: 'applying', phase: 'account' } };
            } });
        expect(requests.filter(request => request.actionId === 'machines.agentIsolation.set')).toHaveLength(writes);
    });
