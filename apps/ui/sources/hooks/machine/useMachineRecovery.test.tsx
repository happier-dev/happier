import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { useMachineRecovery } from './useMachineRecovery';

const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
    allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: {} },
    desired: 'start', desiredWhen: 'now', intentRevision: 7, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });

// Protocol's installed host adapters are the process boundary. Keep selection,
// schemas, Action policy and dispatch real beneath the hook.
function host() {
    const effects: string[] = [];
    const executor = createActionExecutor({
        managedMachineAction: async ({ actionId, input }) => {
            effects.push(actionId);
            expect(input).toMatchObject({ homeId: 'home', managedId: 'managed', expectedIntentRevision: 7 });
            return { managedId: 'managed' };
        },
    } as ActionExecutorDeps);
    return { effects, execute: (actionId: Parameters<typeof executor.execute>[0], input: unknown) => executor.execute(actionId, input,
        { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId } }) };
}

describe('Machine recovery hook', () => {
    it.each([
        { kind: 'retryInstallation', managed: machine, online: false, guestPayloadStale: false },
        { kind: 'update', managed: { ...machine, enrolledMachineId: 'guest' }, online: true, guestPayloadStale: true },
        { kind: 'restartDaemon', managed: { ...machine, enrolledMachineId: 'guest', observation: {
            observedAt: 1, availability: 'present' as const, power: 'running' as const, storage: 'retained' as const } }, online: false, guestPayloadStale: false },
    ])('selects and dispatches $kind through the Home installer Action', async ({ kind, ...facts }) => {
        const boundary = host();
        const hook = await renderHook(() => useMachineRecovery({ ...facts, execute: boundary.execute }));
        const recovery = hook.getCurrent();
        expect(recovery.kind).toBe(kind);
        if (recovery.kind === 'unavailable') throw new Error(recovery.reason);
        expect(recovery.actionId).toBe('machines.managed.bootstrap.retry');
        expect(await recovery.run()).toMatchObject({ ok: true });
        expect(boundary.effects).toEqual(['machines.managed.bootstrap.retry']);
        await hook.unmount();
    });

    it.each([
        { managed: null, online: false, reason: 'notManaged' },
        { managed: { ...machine, enrolledMachineId: 'guest' }, online: true, reason: 'recoveryUnavailable' },
        { managed: { ...machine, enrolledMachineId: 'guest' }, online: null, reason: 'recoveryUnavailable' },
        { managed: { ...machine, desired: 'delete' as const }, online: false, reason: 'recoveryUnavailable' },
        { managed: { ...machine, enrolledMachineId: 'guest', desired: 'stop' as const, submittedNativeEffect: { intentRevision: 7, requestId: 'stop', intent: 'stop' as const },
            observation: { observedAt: 1, availability: 'present' as const, power: 'running' as const } },
            online: false, reason: 'recoveryUnavailable' },
        { managed: { ...machine, enrolledMachineId: 'guest', observation: { observedAt: 1,
            availability: 'present' as const, power: 'stopped' as const } }, online: false, reason: 'recoveryUnavailable' },
    ])('refuses $reason without dispatch', async ({ reason, ...facts }) => {
        const boundary = host();
        const hook = await renderHook(() => useMachineRecovery({ ...facts, execute: boundary.execute }));
        expect(hook.getCurrent()).toEqual({ kind: 'unavailable', reason });
        expect(boundary.effects).toEqual([]);
        await hook.unmount();
    });
});
