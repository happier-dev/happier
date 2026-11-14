import { describe, expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { executeManagedMachineResize } from './resize.js';
import type { ManagedNativeInvocation } from './reconcile.js';

const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
const provisioner = { actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', resize: 'resize' } };
const restartingProvisioner = { ...provisioner, resize: {
    cpuCores: { kind: 'supported' as const, requiresRestart: true, changes: 'any' as const },
    memoryBytes: { kind: 'supported' as const, requiresRestart: true, changes: 'any' as const },
    diskBytes: { kind: 'supported' as const, requiresRestart: true, changes: 'grow-only' as const },
} };

describe('admitted managed resize', () => {
    it('returns typed unsupported for a provider without resize and performs no native effect', async () => {
        const { resize: _resize, ...actions } = provisioner.actions;
        const value = await executeManagedMachineResize({ machine, size: { memoryBytes: 4096 }, provisioner: { actions },
            invoke: async () => { throw new Error('Unsupported provider must not execute native roles'); } });
        expect(value).toEqual({ result: { kind: 'unsupported', dimension: 'memoryBytes', code: 'resize_unsupported' } });
    });
    it('restarts a running guest once and confirms from observed size, using the approved size', async () => {
        const calls: unknown[] = [];
        let power = 'running';
        let memoryBytes = 2 * 1024 ** 3;
        const size = { memoryBytes: 4 * 1024 ** 3 };
        const value = await executeManagedMachineResize({ machine, size, provisioner: restartingProvisioner,
            invoke: async (role, body): ReturnType<ManagedNativeInvocation> => {
                calls.push({ role, body });
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power, size: { memoryBytes } };
                if (role === 'resize') { memoryBytes = size.memoryBytes; return { kind: 'confirmed' }; }
                if (role === 'power') { power = (body as { intent: string }).intent === 'stop' ? 'stopped' : 'running'; return { kind: 'confirmed' }; }
                throw new Error(role);
            } });
        expect(value.result).toEqual({ kind: 'confirmed' });
        const observedSize = value.observation && 'size' in value.observation ? value.observation.size : undefined;
        expect(observedSize).toEqual(size);
        expect(calls.filter(call => (call as { role: string }).role !== 'inspect')).toEqual([
            { role: 'power', body: { resource: { id: 'native' }, intent: 'stop' } },
            { role: 'resize', body: { resource: { id: 'native' }, size } },
            { role: 'power', body: { resource: { id: 'native' }, intent: 'start' } },
        ]);
    });
    it('does not claim success from a native acknowledgement without observed size', async () => {
        const value = await executeManagedMachineResize({ machine, size: { cpuCores: 4 }, provisioner,
            invoke: async (role): ReturnType<ManagedNativeInvocation> => role === 'inspect' ? { observedAt: 1, availability: 'present', power: 'running', size: { cpuCores: 2 } } : { kind: 'confirmed' } });
        expect(value.result).toEqual({ kind: 'unknown', code: 'resize_unconfirmed' });
    });
    it('preserves a stopped guest and settles from the size the provider observes', async () => {
        let power = 'stopped';
        let diskBytes = 1024;
        const effects: string[] = [];
        const value = await executeManagedMachineResize({ machine, size: { diskBytes: 2048 }, provisioner: restartingProvisioner,
            invoke: async (role, body): ReturnType<ManagedNativeInvocation> => {
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power, size: { diskBytes } };
                if (role === 'resize') { effects.push('resize'); diskBytes = 2048; return { kind: 'confirmed' }; }
                if (role === 'power') {
                    const { intent } = body as { intent: string };
                    effects.push(intent); power = intent === 'start' ? 'running' : 'stopped';
                    return { kind: 'confirmed' };
                }
                throw new Error(role);
            } });
        expect(value).toMatchObject({ result: { kind: 'confirmed' }, observation: { power: 'stopped', size: { diskBytes: 2048 } } });
        expect(effects).toEqual(['resize']);
    });
    it('retains a dimension-specific native refusal without restarting live compute', async () => {
        const calls: string[] = [];
        const value = await executeManagedMachineResize({ machine, size: { diskBytes: 1024 }, provisioner,
            invoke: async (role): ReturnType<ManagedNativeInvocation> => { calls.push(role); return { kind: 'unsupported', dimension: 'diskBytes', code: 'disk_immutable' }; } });
        expect(value).toEqual({ result: { kind: 'unsupported', dimension: 'diskBytes', code: 'disk_immutable' } });
        expect(calls).toEqual(['resize']);
    });
    it('restores a running guest after native resize throws and preserves the failure', async () => {
        let power = 'running';
        const failure = new Error('native edit failed');
        await expect(executeManagedMachineResize({ machine, size: { cpuCores: 4 }, provisioner: restartingProvisioner,
            invoke: async (role, body): ReturnType<ManagedNativeInvocation> => {
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power };
                if (role === 'resize') throw failure;
                if (role === 'power') { power = (body as { intent: string }).intent === 'stop' ? 'stopped' : 'running'; return { kind: 'confirmed' }; }
                throw new Error(role);
            } })).rejects.toBe(failure);
        expect(power).toBe('running');
    });
    it('preserves the resize refusal when restoring previous power is unconfirmed', async () => {
        let power = 'running';
        const effects: string[] = [];
        const value = await executeManagedMachineResize({ machine, size: { diskBytes: 512 }, provisioner: restartingProvisioner,
            invoke: async (role, body): ReturnType<ManagedNativeInvocation> => {
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power };
                if (role === 'resize') return { kind: 'unsupported', dimension: 'diskBytes', code: 'resize_shrink_unsupported' };
                if (role === 'power') {
                    const intent = (body as { intent: string }).intent;
                    effects.push(intent);
                    if (intent === 'start') return { kind: 'unknown', code: 'native_power_unknown' };
                    power = 'stopped'; return { kind: 'confirmed' };
                }
                throw new Error(role);
            } });
        expect(value.result).toEqual({ kind: 'unsupported', dimension: 'diskBytes', code: 'resize_shrink_unsupported' });
        expect(value.observation?.power).toBe('stopped');
        expect(effects).toEqual(['stop', 'start']);
    });
});
