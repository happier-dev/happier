import { describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, applyMachineSetupEffectPlans, checkMachineSetupEffectPlan, createMachineSetupEffectPlan, type MachineRecipeStepV1, type MachineSetupBackend, type MachineSetupProgressV1 } from './index.js';
import { createMachineSetupNativeBackend } from './nativeBackend.js';
import { MachineSetupEffectPlanV1Schema, MachineRecipeStepDeclarationV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

// Native process/filesystem is the genuine boundary; the plan and interpreter remain real.
function nativeBoundary() {
    const installed = new Set<string>();
    const writes: string[] = [];
    const backend: MachineSetupBackend = {
        async observe(step) { return { stepId: step.id, status: installed.has(step.id) ? 'satisfied' : 'drifted', facts: { installed: installed.has(step.id) } }; },
        async apply(step) { installed.add(step.id); writes.push(step.id); },
    };
    return { backend, installed, writes };
}
const steps: MachineRecipeStepV1[] = [{ id: 'docker-membership', kind: 'group', name: 'docker', members: ['happier'] }];
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };

describe('machine setup reviewed execution', () => {
    it('binds the admitted operation rather than observations and reads unchanged native state once at Apply', async () => {
        let present = false, observations = 0;
        const writes: string[] = [];
        const backend: MachineSetupBackend = {
            async observe(step) { observations++; return { stepId: step.id,
                status: present ? 'satisfied' : 'drifted', facts: { present } }; },
            async apply(step) { writes.push(step.id); present = true; },
        };
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        present = true;
        const current = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(current.planDigest).toBe(plan.planDigest);
        observations = 0;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(observations).toBe(1);
        expect(writes).toEqual([]);
        observations = 0;
        expect(await applyMachineSetupEffectPlan({ plan: { ...plan, steps: [{ id: 'docker-membership', kind: 'group', name: 'other-group', members: ['happier'] }] }, backend })).toMatchObject({ status: 'plan_changed', completedStepIds: [] });
        expect(observations).toBe(0);
        expect(writes).toEqual([]);
    });

    it('retains isolation native identity custody until its root-side pins replace CHECK and APPLY', async () => {
        const step: MachineRecipeStepV1 = { id: 'agent-account', kind: 'user', username: 'member', uid: 1001,
            home: '/retained/member', locked: true };
        let home = '/retained/member';
        const writes: string[] = [];
        const backend: MachineSetupBackend = {
            async observe() { return { stepId: step.id, status: home === '/retained/member' ? 'satisfied' : 'drifted',
                facts: { present: true, uid: 1001, username: 'member', home, locked: true } }; },
            async apply(value) { writes.push(value.id); },
        };
        const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'agentIsolation', machineId: 'machine-a', enabled: true,
            expectedPolicy: { enabled: true } }, steps: [step], backend });
        home = '/other/member';
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'plan_changed', completedStepIds: [] });
        expect(writes).toEqual([]);
    });

    it('executes a retained pre-cut reviewed plan without rewriting its recorded digest', async () => {
        // Captured from the real pre-cut producer in D-MACH wave62's RED:
        // same basis/steps and present:false native observation, full-value hash.
        const plan = MachineSetupEffectPlanV1Schema.parse({ v: 1, basis, steps,
            nativeFacts: [{ stepId: 'docker-membership', status: 'drifted', facts: { present: false } }],
            planDigest: '16ecb62591b058da9f1ba13dea1d4eb0289ebf0ef803d6f8c23724f7fb975b62' });
        let observations = 0;
        const writes: string[] = [];
        const backend: MachineSetupBackend = {
            async observe(step) { observations++; return { stepId: step.id, status: 'satisfied', facts: { present: true } }; },
            async apply(step) { writes.push(step.id); },
        };
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(observations).toBe(1);
        expect(writes).toEqual([]);
        expect(plan.planDigest).toBe('16ecb62591b058da9f1ba13dea1d4eb0289ebf0ef803d6f8c23724f7fb975b62');
        observations = 0;
        expect(await applyMachineSetupEffectPlan({ plan: { ...plan, basis: { ...basis, managedId: 'other' } }, backend }))
            .toMatchObject({ status: 'plan_changed', completedStepIds: [] });
        expect(observations).toBe(0);
    });

    it('executes only a standalone host-built reboot plan and leaves restoration to its Action', async () => {
        const commands: string[] = [];
        let init = 'systemd', reads = 0, exitCode = 0;
        const backend = createMachineSetupNativeBackend({ platform: 'linux',
            readNativeInit: async () => { reads++; return init; },
            run: async command => { commands.push(`${command.executable} ${command.args.join(' ')}`); return { code: exitCode, stdout: '', stderr: '' }; } });
        const reboot = { id: 'reboot', kind: 'reboot' } as const;
        const input = { basis: { kind: 'reboot', machineId: 'machine-a', operationId: 'operation-a' } as const, steps: [reboot], backend };
        const plan = await checkMachineSetupEffectPlan(input);
        expect(MachineRecipeStepDeclarationV1Schema.safeParse(reboot).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, basis }).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, steps: [reboot, steps[0]],
            nativeFacts: [...plan.nativeFacts, { stepId: steps[0]!.id, status: 'drifted', facts: {} }] }).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, checks: [], checkFacts: [] }).success).toBe(false);
        const ordinary = await checkMachineSetupEffectPlan({ basis, steps: [], backend });
        expect(await applyMachineSetupEffectPlans({ plans: [plan, ordinary].map(value => ({ plan: value })), backend }))
            .toMatchObject({ status: 'plan_changed', completedStepIds: [] });
        const cancelled = new AbortController(); cancelled.abort();
        expect(await applyMachineSetupEffectPlan({ plan, backend, signal: cancelled.signal }))
            .toMatchObject({ status: 'cancelled', completedStepIds: [] });
        init = 'other-init';
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'unsupported', completedStepIds: [] });
        expect(commands).toEqual([]);
        init = 'systemd'; reads = 0;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toEqual({ status: 'applied', completedStepIds: ['reboot'], daemonRestartRequired: false });
        // One pre-effect digest read and the native owner's dispatch check;
        // no post-dispatch check can claim a restored boot or service.
        expect(reads).toBe(2);
        expect(commands).toEqual(['systemctl --no-block reboot']);
        exitCode = 1;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'outcome_unknown', reason: 'native_effect_failed' });
        const unsupported = await checkMachineSetupEffectPlan({ ...input,
            backend: createMachineSetupNativeBackend({ platform: 'win32', run: async () => { throw new Error('Unsupported reboot must never launch'); } }) });
        expect(unsupported.nativeFacts).toMatchObject([{ status: 'unsupported', reason: 'platform_unsupported' }]);
    });

    it('reobserves dependent steps after its own group effects invalidate their initial satisfaction', async () => {
        let accountGroups = 'original', managerGroups = 'original';
        const effects: string[] = [];
        const group: MachineRecipeStepV1 = { id: 'workspace-group', kind: 'group', name: 'happier-workspace', members: ['happier'] };
        const manager: MachineRecipeStepV1 = { id: 'user-manager', kind: 'command', executable: 'systemctl', args: ['restart', 'user@1000.service'],
            check: { executable: 'manager-groups-match', args: [], unsatisfiedExitCodes: [1] } };
        // The OS boundary represents an already-active manager whose kernel
        // groups do not change when the account database gains membership.
        const backend: MachineSetupBackend = {
            async observe(step) { return { stepId: step.id, status: (step.id === group.id
                ? accountGroups === 'workspace' : managerGroups === accountGroups) ? 'satisfied' : 'drifted', facts: {} }; },
            async apply(step) { effects.push(step.id);
                if (step.id === group.id) accountGroups = 'workspace'; else managerGroups = accountGroups; },
        };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [group, manager], backend });
        expect(plan.nativeFacts.map(fact => fact.status)).toEqual(['drifted', 'satisfied']);
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', daemonRestartRequired: true });
        expect(managerGroups).toBe('workspace');
        expect(effects).toEqual(['workspace-group', 'user-manager']);
        const retry = await checkMachineSetupEffectPlan({ basis, steps: [group, manager], backend });
        expect(await applyMachineSetupEffectPlan({ plan: retry, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [], daemonRestartRequired: false });
        expect(effects).toEqual(['workspace-group', 'user-manager']);
    });

    it('retains completed recipe effects when a later program loses its current native observation', async () => {
        const installed = new Set<string>();
        const backend: MachineSetupBackend = {
            async observe(step) {
                if (step.id === 'second' && installed.has('first')) throw new Error('private-native-output');
                return { stepId: step.id, status: installed.has(step.id) ? 'satisfied' : 'drifted', facts: {} };
            },
            async apply(step) { installed.add(step.id); },
        };
        const plans = await Promise.all(['first', 'second'].map(async id => {
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [{ id, kind: 'group', name: id, members: ['happier'] }], backend });
            return { plan };
        }));
        await expect(applyMachineSetupEffectPlans({ plans, backend })).resolves.toMatchObject({
            status: 'outcome_unknown', completedStepIds: ['first'], stepId: 'second', reason: 'required_fact_unavailable',
        });
        expect([...installed]).toEqual(['first']);
    });
    it('binds every reviewed recipe input even when it does not change the concrete steps', () => {
        const selection = { ref: { pluginId: 'example.machine', recipeId: 'configured', revision: '1' }, inputs: { reviewedLabel: 'first' } };
        const input = { basis: { kind: 'setup' as const, machineId: 'machine-a', desiredRevision: 0, selection }, steps: [], nativeFacts: [] };
        const first = createMachineSetupEffectPlan(input);
        const second = createMachineSetupEffectPlan({ ...input, basis: { ...input.basis,
            selection: { ...selection, inputs: { reviewedLabel: 'second' } } } });
        expect(first.steps).toEqual(second.steps);
        expect(first.planDigest).not.toBe(second.planDigest);
        expect(first.basis).toEqual(input.basis);
    });

    it('rechecks selection probes before effects and never applies a probe as an effect', async () => {
        let conditionSatisfied = false, configured = false;
        const writes: string[] = [];
        const probe: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'condition', kind: 'command', executable: 'never-apply-probe', args: [],
            check: { executable: 'fixture-condition', args: [], unsatisfiedExitCodes: [1] } };
        const effect: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'configure', kind: 'command', executable: 'fixture-configure', args: [],
            check: { executable: 'fixture-configured', args: [], unsatisfiedExitCodes: [1] } };
        // The OS command boundary is substituted; observation, plan hashing,
        // native revalidation and mutation dispatch are the production owners.
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'fixture-condition') return { code: conditionSatisfied ? 0 : 1, stdout: '', stderr: '' };
            if (command.executable === 'fixture-configured') return { code: configured ? 0 : 1, stdout: '', stderr: '' };
            writes.push(command.executable);
            if (command.executable === 'fixture-configure') configured = true;
            return { code: 0, stdout: '', stderr: '' };
        } });
        const input = { basis, steps: [effect], checks: [probe], backend };
        const plan = await checkMachineSetupEffectPlan(input);
        expect(plan).toMatchObject({ checks: [probe], checkFacts: [{ stepId: probe.id, status: 'drifted' }] });
        conditionSatisfied = true;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [effect.id] });
        expect(writes).toEqual(['fixture-configure']);
        const current = await checkMachineSetupEffectPlan(input);
        expect(await applyMachineSetupEffectPlan({ plan: current, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(writes).toEqual(['fixture-configure']);
    });

    it('retains unselected manager evidence without blocking the selected package or losing root currentness', async () => {
        let present = false, alternativeAvailable = false;
        const writes: string[] = [];
        const effect: MachineRecipeStepV1 = { id: 'apt-install', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] };
        const other: MachineRecipeStepV1 = { id: 'brew-choice', kind: 'package', manager: 'brew', packages: [{ name: 'wanted', kind: 'formula' }] };
        const backend: MachineSetupBackend = {
            async observe(step): ReturnType<MachineSetupBackend['observe']> {
                const facts: Record<string, string | boolean> = step.id === other.id ? { manager: 'brew' } : { present };
                return { stepId: step.id, status: step.id === other.id ? alternativeAvailable ? 'satisfied' : 'unsupported' : present ? 'satisfied' : 'drifted',
                    ...(!alternativeAvailable && step.id === other.id ? { reason: 'required_fact_unavailable' } : {}), facts };
            },
            async apply(step) { writes.push(step.id); present = true; },
        };
        const checked = await checkMachineSetupEffectPlan({ basis, steps: [effect], checks: [other], backend });
        // Parse the public envelope so this RED compiles before the optional
        // selection-evidence field exists in the strict Protocol schema.
        const admitted = MachineSetupEffectPlanV1Schema.parse({ ...checked, selectedCheckIds: [] });
        const { v: _version, planDigest: _digest, ...contents } = admitted;
        const plan = createMachineSetupEffectPlan(contents);
        alternativeAvailable = true;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: ['apt-install'] });
        expect(writes).toEqual(['apt-install']);
        alternativeAvailable = false;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(writes).toEqual(['apt-install']);
    });

    it('cannot report an empty selection successful while a demanded native probe remains unavailable', async () => {
        const writes: string[] = [];
        const probe: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'condition', kind: 'command', executable: 'never-apply-probe', args: [],
            check: { executable: 'fixture-condition', args: [], unsatisfiedExitCodes: [1] } };
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'fixture-condition') return { code: 2, stdout: '', stderr: '' };
            writes.push(command.executable);
            return { code: 0, stdout: '', stderr: '' };
        } });
        const input = { basis, steps: [], checks: [probe], backend };
        const plan = await checkMachineSetupEffectPlan(input);
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'unavailable', stepId: probe.id, completedStepIds: [] });
        expect(writes).toEqual([]);
    });

    it('refuses a missing exact package when no supported fallback selected an effect', async () => {
        const check: MachineRecipeStepV1 = { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] };
        const backend: MachineSetupBackend = {
            async observe(step) { return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable',
                facts: { requiredFact: 'packageAvailability', package: 'wanted' } }; },
            async apply() { throw new Error('No unsupported fallback may mutate'); },
        };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [], checks: [check], selectedCheckIds: [], backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'unsupported', stepId: 'package', completedStepIds: [] });
    });

    it('binds the same digest before and after stdin JSON serialization of omitted optional fields', () => {
        const step: MachineRecipeStepV1 = { id: 'account', kind: 'user', username: 'happier', home: undefined };
        const value = { basis, steps: [step], nativeFacts: [{ stepId: 'account', status: 'drifted' as const, facts: { present: false } }] };
        const original = createMachineSetupEffectPlan(value);
        const transported = createMachineSetupEffectPlan({ ...value, steps: [{ id: 'account', kind: 'user', username: 'happier' }] });
        expect(original.planDigest).toBe(transported.planDigest);
    });
    it('rechecks the root-side digest before effects and reports only redacted step progress', async () => {
        const os = nativeBoundary();
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend: os.backend });
        const events: MachineSetupProgressV1[] = [];
        const result = await applyMachineSetupEffectPlan({ plan, backend: os.backend, onProgress: (event) => events.push(event) });
        expect(result).toMatchObject({ status: 'applied', completedStepIds: ['docker-membership'], daemonRestartRequired: true });
        expect(os.writes).toEqual(['docker-membership']);
        expect(events).toEqual([
            { stepId: 'docker-membership', phase: 'check', status: 'drifted' },
            { stepId: 'docker-membership', phase: 'apply', status: 'started' },
            { stepId: 'docker-membership', phase: 'verify', status: 'satisfied' },
        ]);
    });
    it('accepts changed native facts while refusing edited plans with zero mutations', async () => {
        const os = nativeBoundary();
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend: os.backend });
        os.installed.add('docker-membership');
        expect((await applyMachineSetupEffectPlan({ plan, backend: os.backend })).status).toBe('applied');
        os.installed.clear();
        expect((await applyMachineSetupEffectPlan({ plan: { ...plan, basis: { ...basis, managedId: 'm-b' } }, backend: os.backend })).status).toBe('plan_changed');
        expect(os.writes).toEqual([]);
    });
    it('fresh retries skip satisfied steps; cancellation and unavailable facts mutate nothing', async () => {
        const os = nativeBoundary();
        os.installed.add('docker-membership');
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend: os.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: os.backend })).status).toBe('applied');
        expect(os.writes).toEqual([]);
        const controller = new AbortController(); controller.abort();
        expect((await applyMachineSetupEffectPlan({ plan, backend: os.backend, signal: controller.signal })).status).toBe('cancelled');
    });
    it('retains completed effects and settles an unconfirmed native failure without exposing native output', async () => {
        const os = nativeBoundary();
        const program: MachineRecipeStepV1[] = [
            { id: 'completed', kind: 'group', name: 'workspace', members: ['happier'] },
            { id: 'unconfirmed', kind: 'group', name: 'docker', members: ['happier'] },
        ];
        const backend: MachineSetupBackend = {
            observe: os.backend.observe,
            async apply(step) {
                if (step.id === 'unconfirmed') throw new Error('secret-native-output');
                await os.backend.apply(step);
            },
        };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: program, backend });
        const result = await applyMachineSetupEffectPlan({ plan, backend });
        expect(result).toMatchObject({ status: 'outcome_unknown', completedStepIds: ['completed'], stepId: 'unconfirmed', daemonRestartRequired: true });
        expect(JSON.stringify(result)).not.toContain('secret-native-output');
        expect(os.writes).toEqual(['completed']);
    });
});
