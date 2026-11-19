import { describe, expect, it } from 'vitest';
import { machineIsolationMetadataFieldV1, readMachineIsolationSnapshotFromMetadataV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import { proposeMachineIsolationOutcome, projectSandboxPresetHostCounts } from './machineIsolationPolicy';
import { renderHook } from '@/dev/testkit';
import { useMachineIsolationProposedOutcome } from '@/hooks/machine/useMachineIsolationPolicy';

describe('New Session Machine policy proposal', () => {
    it('counts a preset once per readable host, including last-known configuration, and flags unreadable policies', () => {
        const entry = { provisioner: { pluginId: 'example.local', localId: 'container' }, presetId: 'preset-a' };
        const policy = { ...machineIsolationMetadataFieldV1.defaultValue(), configuredSandboxes: { one: entry, two: entry } };
        const readable = { metadata: { isolationPolicyV1: policy }, metadataVersion: 1 };
        const result = projectSandboxPresetHostCounts([readable, readable, { metadata: null, metadataVersion: 1 }]);
        expect([...result.counts]).toEqual([['preset-a', 2]]);
        expect(result.complete).toBe(false);
        expect(projectSandboxPresetHostCounts([readable]).complete).toBe(true);
    });
    it('updates the mounted authoring proposal from its synced snapshot and draft choice', async () => {
        const policy = machineIsolationMetadataFieldV1.defaultValue();
        const snapshot = readMachineIsolationSnapshotFromMetadataV1({ metadata: { isolationPolicyV1: policy }, metadataVersion: 1 });
        const hook = await renderHook(({ current, override }: { current: typeof snapshot; override?: 'directly' }) =>
            useMachineIsolationProposedOutcome(current, 'sessions', override), { initialProps: { current: snapshot } });
        try {
            expect(hook.getCurrent()).toMatchObject({ status: 'proposed', choice: { kind: 'directly' } });
            const updated = readMachineIsolationSnapshotFromMetadataV1({ metadata: { isolationPolicyV1: { ...policy,
                configuredSandboxes: { kept: { provisioner: { pluginId: 'example.local', localId: 'container' }, presetId: 'kept' } },
                workKinds: { ...policy.workKinds, sessions: { kind: 'sandbox', configuredSandboxId: 'kept', lifecycle: 'shared-kept' } },
            } }, metadataVersion: 2 });
            await hook.rerender({ current: updated });
            expect(hook.getCurrent()).toMatchObject({ status: 'proposed', choice: { kind: 'sandbox', lifecycle: 'shared-kept' } });
            await hook.rerender({ current: updated, override: 'directly' });
            expect(hook.getCurrent()).toMatchObject({ status: 'proposed', choice: { kind: 'directly' } });
            await hook.rerender({ current: { status: 'locked' } });
            expect(hook.getCurrent()).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('describes stored work-kind choices and a proposed override without admitting the start', () => {
        const policy = { ...machineIsolationMetadataFieldV1.defaultValue(), configuredSandboxes: {
            python: { provisioner: { pluginId: 'example.local', localId: 'container' }, presetId: 'python-preset' },
        }, workKinds: { sessions: { kind: 'sandbox' as const, configuredSandboxId: 'python', lifecycle: 'fresh' as const },
            botsChannels: { kind: 'directly' as const }, automationsWorkflows: { kind: 'directly' as const } } };
        const snapshot = readMachineIsolationSnapshotFromMetadataV1({ metadata: { isolationPolicyV1: policy }, metadataVersion: 1 });
        expect(proposeMachineIsolationOutcome(snapshot, 'sessions')).toEqual({ status: 'proposed', workKind: 'sessions',
            choice: policy.workKinds.sessions, configuredSandbox: policy.configuredSandboxes.python });
        expect(proposeMachineIsolationOutcome(snapshot, 'botsChannels')).toEqual({ status: 'proposed',
            workKind: 'botsChannels', choice: { kind: 'directly' } });
        expect(proposeMachineIsolationOutcome(snapshot, 'sessions', 'directly')).toEqual({ status: 'proposed',
            workKind: 'sessions', choice: { kind: 'directly' } });
    });

    it('leaves absent and unopened policies unknown and exposes a dangling configured choice as unavailable', () => {
        const absent = readMachineIsolationSnapshotFromMetadataV1({ metadata: {}, metadataVersion: 1 });
        expect(proposeMachineIsolationOutcome(absent, 'sessions')).toBeNull();
        expect(proposeMachineIsolationOutcome({ status: 'locked' }, 'sessions')).toBeNull();
        expect(proposeMachineIsolationOutcome({ status: 'invalid' }, 'sessions')).toBeNull();
        const policy = machineIsolationMetadataFieldV1.defaultValue();
        const dangling = readMachineIsolationSnapshotFromMetadataV1({ metadata: { isolationPolicyV1: { ...policy,
            workKinds: { ...policy.workKinds, sessions: { kind: 'sandbox', configuredSandboxId: 'missing', lifecycle: 'fresh' } },
        } }, metadataVersion: 2 });
        expect(proposeMachineIsolationOutcome(dangling, 'sessions')).toEqual({ status: 'unavailable',
            reason: 'machine_isolation_sandbox_unavailable' });
    });
});
