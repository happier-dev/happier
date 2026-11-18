import { describe, expect, it } from 'vitest';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

import { describeMachineIsolationNativeSupport, machineIsolationSandboxUsedWorkKinds, MACHINE_ISOLATION_WORK_KINDS, withMachineIsolationLifecycle,
    withMachineIsolationSandbox, withMachineIsolationWorkTarget, withoutMachineIsolationSandbox } from './machineIsolationChoices';

const docker = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' };
const policy: MachineIsolationPolicyV1 = {
    configuredSandboxes: { node: { provisioner: docker, presetId: 'node-22' }, py: { provisioner: docker, presetId: 'py' } },
    workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'shared-kept' },
        botsChannels: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' }, automationsWorkflows: { kind: 'directly' } },
    agentNativeSandboxEnabled: true,
};

describe('machine isolation choices', () => {
    it('lists the work kinds in the policy owner’s order', () => {
        expect(MACHINE_ISOLATION_WORK_KINDS).toEqual(['sessions', 'botsChannels', 'automationsWorkflows']);
    });

    it('projects the kinds of work assigned to each saved sandbox, including unused ones', () => {
        expect(machineIsolationSandboxUsedWorkKinds(policy, 'node')).toEqual(['sessions', 'botsChannels']);
        expect(machineIsolationSandboxUsedWorkKinds(policy, 'py')).toEqual([]);
        const moved = withMachineIsolationWorkTarget(policy, 'sessions', 'py');
        expect(machineIsolationSandboxUsedWorkKinds(moved, 'node')).toEqual(['botsChannels']);
        expect(machineIsolationSandboxUsedWorkKinds(moved, 'py')).toEqual(['sessions']);
    });

    it('keeps a kind’s lifecycle when it moves to another sandbox, and starts a new choice as new each time', () => {
        expect(withMachineIsolationWorkTarget(policy, 'sessions', 'py').workKinds.sessions)
            .toEqual({ kind: 'sandbox', configuredSandboxId: 'py', lifecycle: 'shared-kept' });
        expect(withMachineIsolationWorkTarget(policy, 'automationsWorkflows', 'py').workKinds.automationsWorkflows)
            .toEqual({ kind: 'sandbox', configuredSandboxId: 'py', lifecycle: 'fresh' });
        expect(withMachineIsolationWorkTarget(policy, 'sessions', null).workKinds.sessions).toEqual({ kind: 'directly' });
        expect(withMachineIsolationLifecycle(policy, 'automationsWorkflows', 'shared-kept')).toBe(policy);
    });

    it('moves every kind of work using a removed sandbox back to Directly in the same policy', () => {
        const next = withoutMachineIsolationSandbox(policy, 'node');
        expect(next.configuredSandboxes).toEqual({ py: { provisioner: docker, presetId: 'py' } });
        expect(next.workKinds).toEqual({ sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } });
    });

    it('names only the chosen sandboxes whose type can’t host the Agent’s own sandbox', () => {
        const entries = [{ id: 'node', name: 'Node 22', supportsAgentNativeSandbox: false }, { id: 'py', name: 'Python', supportsAgentNativeSandbox: false }];
        expect(describeMachineIsolationNativeSupport(policy, entries)).toEqual({ usesSandbox: true, unsupported: ['Node 22'], allUnsupported: true });
    });

    it('adds a type and preset once, and can put the kind of work it was opened for into it', () => {
        const again = withMachineIsolationSandbox(policy, { provisioner: docker, presetId: 'node-22' }, () => 'other');
        expect(again).toEqual({ policy, id: 'node' });
        const added = withMachineIsolationSandbox(policy, { provisioner: docker, presetId: 'go', useFor: 'automationsWorkflows' }, () => 'go-1');
        expect(added.policy.configuredSandboxes['go-1']).toEqual({ provisioner: docker, presetId: 'go' });
        expect(added.policy.workKinds.automationsWorkflows).toEqual({ kind: 'sandbox', configuredSandboxId: 'go-1', lifecycle: 'fresh' });
        expect(added.policy.workKinds.sessions).toBe(policy.workKinds.sessions);
    });
});
