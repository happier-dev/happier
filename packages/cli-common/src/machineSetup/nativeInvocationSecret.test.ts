import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const basis = { kind: 'bootstrap' as const, managedId: 'fixture', operationId: 'fixture', admittedInputDigest: 'a'.repeat(64) };

it('renders reviewed numeric policy inputs through the same file template owner', () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'policy', revision: '1', title: 'Policy',
        inputSchema: { type: 'object', properties: { retries: { type: 'integer', minimum: 1 } }, required: ['retries'], additionalProperties: false },
        steps: [{ id: 'policy', kind: 'file', path: '/etc/example-policy', owner: 'root', group: 'root', mode: 0o644,
            content: { kind: 'template', value: 'maxretry = {retries}\n', variables: { retries: { kind: 'input', path: 'retries' } } } }] });
    expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { retries: 7 })).toMatchObject({ content: { kind: 'literal', value: 'maxretry = 7\n' } });
    expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { retries: { value: 7 } })).toThrow();
});

it('binds reviewed jail expectations without treating submitted objects as declarations', () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'jail', revision: '1', title: 'Jail',
        inputSchema: { type: 'object', properties: { retries: { type: 'integer' } }, required: ['retries'], additionalProperties: false },
        steps: [{ id: 'policy', kind: 'file', path: '/etc/example-policy', owner: 'root', group: 'root', mode: 0o644,
            content: { kind: 'literal', value: 'maxretry=7\n' }, probe: { kind: 'fail2ban', jails: {
                sshd: { maxRetry: { kind: 'input', path: 'retries' }, findTimeSeconds: 600, banTimeSeconds: 3600 },
            } } }] });
    expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { retries: 7 })).toMatchObject({
        probe: { jails: { sshd: { maxRetry: 7 } } },
    });
    expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { retries: { kind: 'input', path: 'other' }, other: 7 })).toThrow();
});

// The native secret-file contract is root:root 0600. Run this suite as root;
// filesystem ownership, private activation and retirement remain real.
describe.skipIf(process.getuid?.() !== 0)('invocation-scoped recipe secret files', () => {
    it.each(['success', 'failure', 'cancelled', 'termination-incomplete'] as const)('keeps the bound auth file through join verification and retires it on %s', async outcome => {
        const root = await mkdtemp('/run/happier-recipe-secret-'); roots.push(root);
        const path = join(root, 'auth-key');
        const recipe = MachineRecipeV1Schema.parse({ id: 'private-join', revision: '1', title: 'Private join',
            inputSchema: { type: 'object', properties: { grant: { type: 'string' } }, required: ['grant'], additionalProperties: false },
            steps: [
                { id: 'auth', kind: 'file', path, owner: 'root', group: 'root', mode: 0o600, lifetime: 'invocation',
                    content: { kind: 'secretGrant', grantRef: { kind: 'input', path: 'grant' } } },
                { id: 'join', kind: 'command', executable: 'tailscale', args: ['up', `--auth-key=file:${path}`],
                    check: { executable: 'tailscale', args: ['status', '--json'], unsatisfiedExitCodes: [1], stdoutJson: {
                        op: 'and', all: [{ op: 'eq', path: 'BackendState', value: 'Running' }, { op: 'eq', path: 'Self.Online', value: true }],
                    } } },
            ] });
        const steps = recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, { grant: 'admitted-connector-grant' }));
        const secret = Buffer.from('invocation-private-key-fixture');
        const controller = new AbortController();
        const terminationIncomplete = Object.assign(new Error('Native exit was not confirmed'), { code: 'plugin_exec_termination_incomplete' });
        let joined = false;
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ signal: controller.signal, platform: 'linux',
            // The existing custody seam supplies previously admitted private bytes.
            async materializeSecretGrant(ref) {
                expect(ref).toBe('admitted-connector-grant');
                return { bytes: Buffer.from(secret), async assertCurrent() { controller.signal.throwIfAborted(); }, dispose() {} };
            },
            async run(command) {
                calls.push(command);
                if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
                    ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
                if (command.args[0] === 'status') {
                    if (joined) expect((await readFile(path)).equals(secret)).toBe(true);
                    return { code: joined ? 0 : 1, stdout: JSON.stringify({ BackendState: joined ? 'Running' : 'NeedsLogin', Self: { Online: joined } }), stderr: '' };
                }
                expect((await readFile(path)).equals(secret)).toBe(true);
                expect((await lstat(path)).mode & 0o777).toBe(0o600);
                joined = true;
                if (outcome === 'termination-incomplete') throw terminationIncomplete;
                if (outcome === 'cancelled') controller.abort();
                return { code: outcome === 'failure' ? 1 : 0, stdout: '', stderr: '' };
            } });
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        const execution = applyMachineSetupEffectPlan({ plan, backend, signal: controller.signal });
        let result: Awaited<typeof execution> | undefined;
        if (outcome === 'termination-incomplete') await expect(execution).rejects.toBe(terminationIncomplete);
        else {
            result = await execution;
            expect(result.status).toBe(outcome === 'success' ? 'applied' : outcome === 'failure' ? 'failed' : 'outcome_unknown');
        }
        expect(joined).toBe(true);
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.stringify({ plan, result, calls })).not.toContain(secret.toString());
    });
});

it('enables and starts a reviewed native timer through the recipe executor', async () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'updates', revision: '1', title: 'Updates',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'timer', kind: 'serviceUnit', unit: 'dnf5-automatic.timer', enabled: true, running: true }] });
    const steps = recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, {}));
    let enabled = false, running = false;
    const backend = createMachineSetupNativeBackend({ platform: 'linux', async run(command) {
        expect(command.executable).toBe('systemctl');
        expect(command.args.at(-1)).toBe('dnf5-automatic.timer');
        if (command.args[0] === 'show') return { code: 0, stdout: `LoadState=loaded\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${running ? 'active' : 'inactive'}\n`, stderr: '' };
        if (command.args[0] === 'enable') enabled = true;
        else if (command.args[0] === 'start') running = true;
        else throw new Error('Unexpected native effect');
        return { code: 0, stdout: '', stderr: '' };
    } });
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['timer'] });
    expect({ enabled, running }).toEqual({ enabled: true, running: true });
});
