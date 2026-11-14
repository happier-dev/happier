import { resolveManagedMachineRuntimeV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { describe, expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { executeManagedMachineWakeThenRun, managedMachineWakePowerInput, prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from './wakeThenRun.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

const asleep = ManagedMachineFullV1Schema.parse({
    id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 4,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
});

describe('explicit managed execution', () => {
    it('retains an ordinary Session target while bypassing all managed runtime work', async () => {
        let placement = 'ordinary-machine';
        let placementReads = 0;
        const reads: ManagedWakePreparationReads = {
            readMachineTarget: async () => ({ reachable: true, managedMachineRef: null }),
            readSessionMachineId: async () => { placementReads++; return placement; },
            readManagedMachine: async () => { throw new Error('Ordinary Machines must not consult managed inventory'); },
            readSelectedProvisioners: async () => { throw new Error('Ordinary Machines must not consult provider admission'); },
        };
        const context = { surface: 'ui' as const };
        const input = { sessionId: 'ordinary-session', intent: 'resume' as const };
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'session.open', input, context,
            machineRuntimeDemand: { target: { kind: 'session', sessionId: input.sessionId }, serverId: 'original-home' } }, reads,
        async () => { throw new Error('Ordinary Machines must not enter managed runtime execution'); });
        expect(prepared).toMatchObject({ children: [] });
        if (!prepared || 'ok' in prepared || !prepared.executeAdmittedAction) throw new Error('Expected original target binding');
        placement = 'later-machine';
        const selected: unknown[] = [];
        expect(await prepared.executeAdmittedAction({ actionId: 'session.open', input, context,
            execute: async (originalContext, target) => {
                expect(originalContext).toBe(context);
                selected.push(target);
                return { ok: true, result: 'original-operation' };
            } })).toEqual({ ok: true, result: 'original-operation' });
        expect(selected).toEqual([{ machineId: 'ordinary-machine', serverId: 'original-home' }]);
        expect(placementReads).toBe(1);
    });

    it('keeps ordinary accepted input at its ACK owner without a finite continuation', async () => {
        expect(await prepareManagedMachineWakeChildren({ actionId: 'session.message.send', input: {}, context: { surface: 'ui' },
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'ordinary-machine' }, activation: 'accepted-input' } }, {
            readMachineTarget: async () => ({ reachable: true, managedMachineRef: null }),
            readSessionMachineId: async () => { throw new Error('The concrete Machine target is already known'); },
            readManagedMachine: async () => { throw new Error('Ordinary Machines must not consult managed inventory'); },
            readSelectedProvisioners: async () => { throw new Error('Ordinary Machines must not consult provider admission'); },
        }, async () => { throw new Error('Accepted input must not enter finite runtime execution'); })).toBeNull();
    });

    it('reviews wake for retained running observations with an unreachable guest so a vendor stop reaches fresh Inspect', async () => {
        const running = { ...asleep, observation: { ...asleep.observation!, power: 'running' as const } };
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'machines.terminal.open', input: { machineId: 'guest' },
            context: { surface: 'ui' }, machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } } },
        { readMachineTarget: async () => ({ reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' } }), readSessionMachineId: async () => null, readManagedMachine: async () => running });
        expect(prepared).toMatchObject({ children: [{ action: 'machines.managed.power.set', role: 'managed-wake',
            input: managedMachineWakePowerInput(running) }] });
    });

    it('admits a reachable guest despite unavailable Inspect while preserving positive loss guards', () => {
        const machine = { ...asleep, observation: { availability: 'unavailable' as const, observedAt: 2 } };
        expect(resolveManagedMachineRuntimeV1(machine, 'guest', true).ready).toBe(true);
        expect(resolveManagedMachineRuntimeV1(machine, 'guest', false).ready).toBe(false);
        expect(resolveManagedMachineRuntimeV1({ ...machine, observation: undefined }, 'guest', true).ready).toBe(false);
        expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, availability: 'absent' } }, 'guest', true).ready).toBe(false);
        expect(resolveManagedMachineRuntimeV1({ ...machine, allocation: 'confirmed-absent' }, 'guest', true).ready).toBe(false);
        expect(resolveManagedMachineRuntimeV1({ ...machine, creationState: 'canceled' }, 'guest', true).ready).toBe(false);
        for (const power of ['stopped', 'suspended'] as const) {
            expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, power } }, 'guest', true).ready).toBe(false);
        }
        expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, storage: 'lost' } }, 'guest', true).ready).toBe(false);
    });

    it('uses reachable execution when the native observation does not report power or storage', () => {
        const machine = { ...asleep, observation: { availability: 'present' as const, observedAt: 1 } };
        expect(resolveManagedMachineRuntimeV1(machine, 'guest', true).ready).toBe(true);
        expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, power: 'unknown' } }, 'guest', true).ready).toBe(true);
        expect(resolveManagedMachineRuntimeV1(machine, 'guest', false).ready).toBe(false);
        for (const power of ['stopped', 'suspended'] as const) {
            expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, power } }, 'guest', true).ready).toBe(false);
        }
        expect(resolveManagedMachineRuntimeV1({ ...machine, observation: { ...machine.observation, storage: 'lost' } }, 'guest', true).ready).toBe(false);
    });

    it.each([
        { controller: true, nativeReady: true }, { controller: true, nativeReady: false },
        { controller: false, nativeReady: true }, { controller: false, nativeReady: false },
    ])('leaves Home-owned accepted input without private native reads (controller: $controller, ready: $nativeReady)', async ({ controller, nativeReady }) => {
        const machine = { ...asleep, controller: controller ? asleep.controller : undefined,
            observation: { ...asleep.observation!, power: nativeReady ? 'running' as const : 'stopped' as const } };
        const runtime = resolveManagedMachineRuntimeV1(machine, 'guest', true);
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'session.message.send',
            input: { sessionId: 'same-session', message: 'hello' }, context: { surface: 'ui' },
            machineRuntimeDemand: { target: { kind: 'session', sessionId: 'same-session' }, activation: 'accepted-input' } }, {
            readSessionMachineId: async () => 'guest',
            readMachineTarget: async () => ({ reachable: true, managedMachineRef: { homeId: 'home', managedId: 'managed' },
                managedInputRuntime: { nativeReady: runtime.ready, wakeState: runtime.wakeState, acceptedInputWakeOwner: runtime.acceptedInputWakeOwner } }),
            // Native detail HTTP is a different authority from the recipient's Machine read.
            readManagedMachine: async () => { throw new ManagedMachineControllerError('permission_denied'); },
        });
        expect(prepared).toBeNull();
    });

    it('flattens Account power and inspect into the same original Send review before any native effect', async () => {
        const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Compute', icon: 'cloud', resourceKind: 'compute',
            schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', power: 'power' } });
        const machine = ManagedMachineFullV1Schema.parse({ ...asleep, controller: undefined, reviewedFacts: { launch: asleep.launch, provisioner,
            optionStatus: 'current', prerequisites: [], billing: provisioner.billing, retentionCapabilities: provisioner.retention,
            retention: asleep.retention, wakeOnAcceptedMessage: false } });
        let reads = 0;
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'session.message.send',
            input: { sessionId: 'same-session', message: 'hello' }, context: { surface: 'agent' },
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' }, activation: 'accepted-input' } },
        { readMachineTarget: async () => ({ reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' } }), readSessionMachineId: async () => null, readManagedMachine: async () => machine,
            readSelectedProvisioners: async () => { reads++; return [{ contribution: asleep.launch.provider,
                occurrenceId: 'selected', acquireExecutionTarget: 'account', descriptor: provisioner }]; } });
        expect(prepared).toEqual({ children: [
            { action: 'machines.managed.power.set', role: 'managed-wake', input: managedMachineWakePowerInput(machine) },
            { action: { pluginId: 'acme.compute', localId: 'inspect' }, role: 'inspect' },
            { action: { pluginId: 'acme.compute', localId: 'power' }, role: 'power' },
        ] });
        expect(reads).toBe(1);
        expect(await prepareManagedMachineWakeChildren({ actionId: 'session.message.send',
            input: { sessionId: 'same-session', message: 'hello' }, context: { surface: 'agent' },
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' }, activation: 'accepted-input' } },
        { readMachineTarget: async () => ({ reachable: true, managedMachineRef: { homeId: 'home', managedId: 'managed' } }), readSessionMachineId: async () => null,
            readManagedMachine: async () => ({ ...machine, observation: { ...machine.observation!, power: 'running' } }),
            readSelectedProvisioners: async () => { throw new Error('Reachable running compute needs no Account catalog work'); } }))
            .toEqual({ children: [] });
        expect(await prepareManagedMachineWakeChildren({ actionId: 'daemon.filesystem.listDirectory', input: {}, context: {} },
        { readMachineTarget: async () => { throw new Error('Passive work cannot read a Machine target'); },
            readSessionMachineId: async () => { throw new Error('Passive work cannot select a Session'); },
            readManagedMachine: async () => { throw new Error('Passive work cannot read managed state'); },
            readSelectedProvisioners: async () => { throw new Error('Passive work cannot read the Account catalog'); } })).toBeNull();
    });

    it('reviews accepted-input wake without attaching a pre-acceptance finite execution continuation', async () => {
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'session.message.send', input: { sessionId: 'same-session', message: 'hello' },
            context: { surface: 'agent' }, machineRuntimeDemand: { target: { kind: 'session', sessionId: 'same-session' }, activation: 'accepted-input' } },
        { readMachineTarget: async () => ({ reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' } }), readSessionMachineId: async () => 'guest', readManagedMachine: async () => asleep },
        async () => ({ ok: true, result: 'must-not-run-before-ack' }));
        expect(prepared).toMatchObject({ children: [{ action: 'machines.managed.power.set', role: 'managed-wake' }] });
        expect(prepared).not.toHaveProperty('executeAdmittedAction');
    });

    it('retains the reviewed Session Machine and exact power operand instead of following a later placement', async () => {
        let placement = 'guest';
        let placementReads = 0;
        let managedReads = 0;
        const context = { surface: 'ui' as const };
        const originalInput = { sessionId: 'same-session', intent: 'resume' as const };
        const demand = { target: { kind: 'session' as const, sessionId: 'same-session' } };
        const reads: ManagedWakePreparationReads = {
            readMachineTarget: async () => ({ reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' } }),
            readSessionMachineId: async () => { placementReads++; return placement; },
            readManagedMachine: async () => { managedReads++; return asleep; },
        };
        const selected: unknown[] = [];
        const effects: string[] = [];
        let ready!: () => void;
        const observation = new Promise<void>(resolve => { ready = resolve; });
        const prepared = await prepareManagedMachineWakeChildren({ actionId: 'session.open', input: originalInput,
            context, machineRuntimeDemand: demand }, reads, async target => {
                selected.push(target);
                return executeManagedMachineWakeThenRun({ powerInput: target.machineRuntime.managed?.powerInput,
                    power: async input => { expect(input).toBe(prepared && !('ok' in prepared) ? prepared.children[0]!.input : undefined); effects.push('power'); },
                    waitUntilReady: async () => { effects.push('ready'); await observation; },
                    run: () => target.execute(target.context),
                });
            });
        if (!prepared || 'ok' in prepared || !prepared.executeAdmittedAction) throw new Error('Expected reviewed wake preparation');
        placement = 'different-guest';
        let originals = 0;
        const operation = prepared.executeAdmittedAction({ actionId: 'session.open', input: originalInput, context,
            execute: async original => { expect(original).toBe(context); originals++; effects.push('original'); return { ok: true, result: 'same-session' }; } });
        await Promise.resolve();
        await Promise.resolve();
        expect(effects).toEqual(['power', 'ready']);
        expect(originals).toBe(0);
        ready();
        expect(await operation).toEqual({ ok: true, result: 'same-session' });
        expect(selected).toMatchObject([{ actionId: 'session.open', input: originalInput,
            machineRuntime: { machineId: 'guest', managed: { homeId: 'home', managedId: 'managed',
            powerInput: prepared.children[0]!.input } } }]);
        expect(placementReads).toBe(1);
        expect(managedReads).toBe(1);
        expect(originals).toBe(1);
        expect(effects).toEqual(['power', 'ready', 'original']);
    });

    it('uses the installed local daemon without reading or re-admitting managed wake work', async () => {
        let managedReads = 0;
        const reads: ManagedWakePreparationReads = { localMachineId: 'guest',
            readMachineTarget: async machineId => {
                if (machineId === 'guest') throw new Error('Installed local runtime needs no target read');
                return { reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' } };
            },
            readSessionMachineId: async () => 'guest',
            readManagedMachine: async () => { managedReads++; return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' }; },
        };
        for (const target of [{ kind: 'machine' as const, machineId: 'guest' }, { kind: 'session' as const, sessionId: 'same-session' }]) {
            expect(await prepareManagedMachineWakeChildren({ actionId: 'execution.run.start', input: {}, context: { surface: 'rpc' },
                machineRuntimeDemand: { target } }, reads)).toBeNull();
        }
        expect(managedReads).toBe(0);
        expect(await prepareManagedMachineWakeChildren({ actionId: 'execution.run.start', input: {}, context: { surface: 'rpc' },
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'remote' } } }, reads))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(managedReads).toBe(1);
    });

    it('uses the declared wake verb when retained stopped compute supports Resume only', () => {
        const machine = ManagedMachineFullV1Schema.parse({ ...asleep, reviewedFacts: buildManagedConfigurationFactsV1({
            choicesSchema: PluginJsonValueV2Schema, launch: asleep.launch, optionStatus: 'current', prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retentionCapabilities: { supportedIntents: ['resume'] },
        }) });
        expect(managedMachineWakePowerInput(machine)).toMatchObject({ intent: 'resume' });
    });

    it('prepares exactly the paid child for an asleep original demand without executing it or consulting unattended consent', async () => {
        const targets: unknown[] = [];
        const reads: ManagedWakePreparationReads = {
            readMachineTarget: async () => ({ reachable: false, managedMachineRef: { homeId: 'home', managedId: 'managed' },
                managedInputRuntime: { nativeReady: false, wakeState: 'asleep', acceptedInputWakeOwner: 'home' } }),
            readSessionMachineId: async () => 'guest',
            readManagedMachine: async target => { targets.push(target); return asleep; },
        };
        const context = { surface: 'agent' as const };
        const request = { actionId: 'session.message.send' as const, input: { sessionId: 'same-session', message: 'hello' }, context };
        expect(await prepareManagedMachineWakeChildren(request, reads)).toBeNull();
        expect(targets).toEqual([]);
        expect(await prepareManagedMachineWakeChildren({ ...request,
            machineRuntimeDemand: { target: { kind: 'session', sessionId: 'same-session' } },
        }, reads)).toEqual({ children: [{ action: 'machines.managed.power.set', role: 'managed-wake', input: {
            homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4, intent: 'start',
        } }] });
        expect(targets).toEqual([{ homeId: 'home', managedId: 'managed' }]);
        const running = { ...asleep, observation: { ...asleep.observation!, power: 'running' as const } };
        expect(await prepareManagedMachineWakeChildren({ ...request,
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } },
        }, { ...reads, readMachineTarget: async () => ({ reachable: true, managedMachineRef: { homeId: 'home', managedId: 'managed' } }), readManagedMachine: async () => running })).toEqual({ children: [] });
        const resuming = { ...asleep, submittedNativeEffect: { intent: 'resume' as const, requestId: 'same-wake', intentRevision: 4 } };
        expect(await prepareManagedMachineWakeChildren({ ...request,
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } },
        }, { ...reads, readManagedMachine: async () => resuming })).toEqual({ children: [] });
    });

    it('executes the exact reviewed power operand once and holds the original operation until observed readiness', async () => {
        const effects: string[] = [];
        let ready!: () => void;
        const observation = new Promise<void>(resolve => { ready = resolve; });
        const powerInput = managedMachineWakePowerInput(asleep);
        const operation = executeManagedMachineWakeThenRun({ powerInput,
            power: async input => { expect(input).toBe(powerInput); effects.push('power'); },
            waitUntilReady: async () => { effects.push('wait'); await observation; },
            run: async () => { effects.push('run'); return 'same-session-thread-workspace'; },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(effects).toEqual(['power', 'wait']);
        ready();
        expect(await operation).toBe('same-session-thread-workspace');
        expect(effects).toEqual(['power', 'wait', 'run']);
    });

    it('waits without issuing an unreviewed power intent', async () => {
        const effects: string[] = [];
        await executeManagedMachineWakeThenRun({
            power: async () => { effects.push('power'); },
            waitUntilReady: async () => { effects.push('wait'); }, run: async () => { effects.push('run'); },
        });
        expect(effects).toEqual(['wait', 'run']);
    });

    it.each(['power', 'readiness'] as const)('preserves a %s refusal without running the requested operation', async phase => {
        const refusal = Object.assign(new Error('managed_power_required'), { code: 'managed_power_required' });
        const effects: string[] = [];
        await expect(executeManagedMachineWakeThenRun({ powerInput: managedMachineWakePowerInput(asleep),
            power: async () => { effects.push('power'); if (phase === 'power') throw refusal; },
            waitUntilReady: async () => { effects.push('wait'); throw refusal; },
            run: async () => { effects.push('run'); },
        })).rejects.toBe(refusal);
        expect(effects).toEqual(phase === 'power' ? ['power'] : ['power', 'wait']);
    });

    it('cancels before the requested operation after readiness settles', async () => {
        const signal = new AbortController();
        let executions = 0;
        await expect(executeManagedMachineWakeThenRun({ powerInput: managedMachineWakePowerInput(asleep), signal: signal.signal,
            power: async () => {}, waitUntilReady: async () => { signal.abort(); },
            run: async () => { executions++; },
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(executions).toBe(0);
    });
});
