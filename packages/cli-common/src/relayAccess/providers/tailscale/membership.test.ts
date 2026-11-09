import { describe, expect, it } from 'vitest';
import { resolveMachineRecipeStepInputsV1, type MachineRecipeV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
    type MachineSetupNativeCommand } from '../../../machineSetup/index.js';
import { tailscaleMembershipPrograms } from './membership.js';
import { tailscaleRelayAccessProvider } from './index.js';

function machine(initialOnline = true) {
    let state = 'Running';
    let online = initialOnline;
    let operator = 'daemon-user';
    const commands: MachineSetupNativeCommand[] = [];
    const nativeEffects: string[][] = [];
    const backend = createMachineSetupNativeBackend({ run: async command => {
        commands.push(command);
        if (command.args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: state, Self: { Online: online } }), stderr: '' };
        if (command.args[0] === 'debug') return { code: 0, stdout: JSON.stringify({ OperatorUser: operator }), stderr: '' };
        nativeEffects.push([...command.args]);
        if (command.args[0] === 'down') state = 'Stopped';
        else if (command.args[0] === 'up') { state = 'Running'; online = true; }
        else if (command.args[0] === 'set') operator = command.args[1]!.slice('--operator='.length);
        return { code: 0, stdout: '', stderr: '' };
    } });
    return { commands, nativeEffects, backend, state: () => state };
}

async function plan(backend: ReturnType<typeof createMachineSetupNativeBackend>, key: boolean) {
    const inputs = { switchNetwork: key, setOperator: false,
        ...(key ? { setupCredentialFile: '/run/happier-machine-credentials/install.setup-key' } : {}) };
    const declaration: MachineRecipeV1 = tailscaleMembershipPrograms.join;
    const steps = declaration.steps.filter(step =>
        (step.when ?? []).every(condition => 'input' in condition && evaluateInputPredicate(condition.input, inputs)))
        .map(step => resolveMachineRecipeStepInputsV1(step, inputs));
    return checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, steps, backend });
}

describe('reviewed builtin Tailscale membership through the native interpreter', () => {
    it('does not accept a Running but offline local node as a completed connection', async () => {
        const f = machine(false);
        const reviewed = await plan(f.backend, false);
        expect(reviewed.nativeFacts).toMatchObject([{ stepId: 'tailscale-resume', status: 'drifted' }]);
        expect(await applyMachineSetupEffectPlan({ plan: reviewed, backend: f.backend })).toMatchObject({ status: 'applied' });
        expect(f.nativeEffects).toEqual([['up']]);
    });
    it('does not change an adopted Running profile’s operator without a selected key', async () => {
        const prepared = await tailscaleRelayAccessProvider.prepareMembership?.({ role: 'join',
            observed: { state: 'ready', networkIdentity: 'existing-tailnet' }, ctx: {
                env: { HAPPIER_TAILSCALE_BIN: '/fixture/tailscale' }, upstreamUrl: null, platform: 'linux',
                runCommand: async request => ({ command: request.command, args: request.args, exitCode: 0,
                    stdout: '[{"id":"existing-profile","selected":true}]', stderr: '' }),
            } });
        expect(prepared).toMatchObject({ ok: true, inputs: { switchNetwork: false, setOperator: false },
            profile: { profileId: 'existing-profile', networkIdentity: 'existing-tailnet' } });
    });

    it.each(['needsAuth', 'stopped'] as const)('does not launch interactive up without a selected key and usable native login (%s)', async state => {
        const commands: string[][] = [];
        const result = await tailscaleRelayAccessProvider.prepareMembership?.({ role: 'join',
            observed: { state, networkIdentity: null }, ctx: { env: { HAPPIER_TAILSCALE_BIN: '/fixture/tailscale' }, upstreamUrl: null,
                runCommand: async request => {
                    commands.push([...request.args]);
                    return { command: request.command, args: request.args, exitCode: 0, stdout: '[]', stderr: '' };
                } } });
        expect(result).toMatchObject({ ok: false, errorCode: state === 'needsAuth' ? 'needsAuth' : 'invalid_provider_output' });
        expect(commands).toEqual(state === 'needsAuth' ? [] : [['switch', '--list', '--json']]);
    });

    it('adopts the observed Running profile with no selected key and no native mutation', async () => {
        const f = machine();
        const reviewed = await plan(f.backend, false);
        expect(reviewed.basis).not.toHaveProperty('selection');
        expect(reviewed.steps.map(step => step.id)).toEqual(['tailscale-resume']);
        const result = await applyMachineSetupEffectPlan({ plan: reviewed, backend: f.backend });
        expect(result).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(f.nativeEffects).toEqual([]);
    });

    it('reauthenticates a selected new key exactly once even when the native profile ID does not change', async () => {
        const f = machine();
        const reviewed = await plan(f.backend, true);
        const result = await applyMachineSetupEffectPlan({ plan: reviewed, backend: f.backend });
        expect(reviewed.steps.map(step => step.id)).toEqual(['tailscale-switch', 'tailscale-join']);
        expect(reviewed.nativeFacts.map(fact => fact.status)).toEqual(['drifted', 'satisfied']);
        expect(reviewed.steps[0]?.review).toMatchObject({ title: 'Switch Tailscale network' });
        expect(result).toMatchObject({ status: 'applied', completedStepIds: ['tailscale-switch', 'tailscale-join'] });
        expect(f.nativeEffects).toEqual([
            ['down'], ['up', '--force-reauth', '--auth-key=file:/run/happier-machine-credentials/install.setup-key'],
        ]);
        expect(f.state()).toBe('Running');
        expect(JSON.stringify(reviewed)).not.toContain('secret-key-value');
    });
});
