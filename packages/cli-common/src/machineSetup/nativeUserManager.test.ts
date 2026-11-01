import { describe, expect, it } from 'vitest';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

const basis = { kind: 'bootstrap' as const, managedId: 'managed', operationId: 'operation', admittedInputDigest: 'a'.repeat(64) };
const managerStep = () => MachineRecipeStepV1Schema.parse({ id: 'daemon-user-manager', kind: 'command', executable: 'systemctl',
    args: ['restart', '--', 'user@1000.service'], check: { kind: 'userManagerGroups', username: 'happier' } });

describe('native user-manager group currency', () => {
    function native(initialManager?: Readonly<{ state: 'inactive' | 'failed' | 'activating'; pid: number }>) {
        let member = false, managerGroups = [1000];
        let managerState = initialManager;
        let managerReads = 0, startup: Readonly<{ read: number; pid: number }> | undefined;
        let processStatus: string | undefined, observationUnavailable = false;
        const effects: string[] = [];
        const run = async ({ executable, args }: MachineSetupNativeCommand) => {
            const result = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
            if (executable === 'getent') return result(args[1] === 'passwd'
                ? 'happier:x:1000:1000::/home/happier:/bin/bash\n' : `happier-workspace:x:1001:${member ? 'happier' : ''}\n`);
            if (executable === 'id') return result(member ? '1000 1001\n' : '1000\n');
            if (executable === 'systemctl' && args[0] === 'show') {
                managerReads += 1;
                if (startup?.read === managerReads) managerState = { state: 'activating', pid: startup.pid };
                return observationUnavailable ? result('', 1)
                    : result(managerState ? `MainPID=${managerState.pid}\nActiveState=${managerState.state}\n` : 'MainPID=27\nActiveState=active\n');
            }
            if (executable === 'cat') return result(processStatus ?? `Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${managerGroups.join(' ')}\n`);
            effects.push(executable);
            if (executable === 'usermod') member = true;
            else if (executable === 'systemctl' && args.join(' ') === 'restart -- user@1000.service') {
                managerGroups = member ? [1000, 1001] : [1000];
                managerState = undefined;
            }
            else throw new Error(`Unexpected native effect: ${executable}`);
            return result();
        };
        return { backend: createMachineSetupNativeBackend({ run }), effects,
            changeAccount: () => { member = true; }, invalidStatus: (value: string) => { processStatus = value; },
            startOnObservation: (read: number, pid: number) => { startup = { read, pid }; },
            loseObservation: () => { observationUnavailable = true; } };
    }

    it.each([
        { state: 'inactive' as const, pid: 0 },
        { state: 'failed' as const, pid: 0 },
        { state: 'activating' as const, pid: 0 },
        { state: 'activating' as const, pid: 27 },
    ])('starts a $state manager with MainPID=$pid, verifies its groups, and performs no effects on retry', async initial => {
        const os = native(initial), manager = managerStep();
        os.changeAccount();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [manager], backend: os.backend });
        expect(plan.nativeFacts[0]).toMatchObject({ status: 'drifted' });
        expect(await applyMachineSetupEffectPlan({ plan, backend: os.backend }))
            .toMatchObject({ status: 'applied', completedStepIds: ['daemon-user-manager'] });
        expect(await os.backend.observe(manager)).toMatchObject({ status: 'satisfied', facts: {
            expectedGroupIds: [1000, 1001], actualGroupIds: [1000, 1001],
        } });
        const retry = await checkMachineSetupEffectPlan({ basis, steps: [manager], backend: os.backend });
        expect(await applyMachineSetupEffectPlan({ plan: retry, backend: os.backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(os.effects).toEqual(['systemctl']);
    });

    it('joins startup that begins between the interpreter observation and the native pre-effect observation', async () => {
        const os = native({ state: 'inactive', pid: 0 }), manager = managerStep();
        // logind may publish its startup job after the outer observation.
        os.startOnObservation(3, 27);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [manager], backend: os.backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend: os.backend }))
            .toMatchObject({ status: 'applied', completedStepIds: ['daemon-user-manager'] });
        expect(await os.backend.observe(manager)).toMatchObject({ status: 'satisfied' });
        expect(os.effects).toEqual(['systemctl']);
    });

    it('refreshes an active manager invalidated by an earlier group effect, then performs no effects on retry', async () => {
        const os = native();
        const group = MachineRecipeStepV1Schema.parse({ id: 'workspace-group', kind: 'group', name: 'happier-workspace', members: ['happier'] });
        const manager = managerStep();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [group, manager], backend: os.backend });
        expect(plan.nativeFacts.map(fact => fact.status)).toEqual(['drifted', 'satisfied']);
        expect(await applyMachineSetupEffectPlan({ plan, backend: os.backend }))
            .toMatchObject({ status: 'applied', completedStepIds: ['workspace-group', 'daemon-user-manager'] });
        expect(await os.backend.observe(manager)).toMatchObject({ status: 'satisfied' });
        expect(os.effects).toEqual(['usermod', 'systemctl']);
        const retry = await checkMachineSetupEffectPlan({ basis, steps: [group, manager], backend: os.backend });
        expect(await applyMachineSetupEffectPlan({ plan: retry, backend: os.backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(os.effects).toEqual(['usermod', 'systemctl']);
    });

    it('refuses unreadable or mismatched process identity without restarting a manager', async () => {
        const os = native(), manager = managerStep();
        os.changeAccount();
        os.invalidStatus('Uid:\t2000\t2000\t2000\t2000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000 1001\n');
        expect(await os.backend.observe(manager)).toMatchObject({ status: 'unavailable' });
        os.loseObservation();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [manager], backend: os.backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend: os.backend }))
            .toMatchObject({ status: 'unavailable', completedStepIds: [] });
        expect(os.effects).toEqual([]);
    });

    it('detects retained membership that has been removed from the account', async () => {
        const os = native();
        os.invalidStatus('Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t1000 1001\n');
        expect(await os.backend.observe(managerStep())).toMatchObject({ status: 'drifted', facts: {
            expectedGroupIds: [1000], actualGroupIds: [1000, 1001],
        } });
        expect(os.effects).toEqual([]);
    });
});
