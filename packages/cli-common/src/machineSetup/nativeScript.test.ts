import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
    createMachineSetupEffectPlan, readMachineSetupInitialPresenceV1, runMachineSetupNativeCommand } from './index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const basis = { kind: 'setup' as const, machineId: 'scripts', desiredRevision: 0 };

it('reports POSIX recipe scripts unsupported on Windows without starting a shell', async () => {
    const step = MachineRecipeStepV1Schema.parse({ id: 'script', kind: 'script', shell: 'bash', body: 'true\n' });
    const backend = createMachineSetupNativeBackend({ platform: 'win32', run: async () => { throw new Error('No process may start'); } });
    const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'unsupported', reason: 'platform_unsupported' });
});

describe.skipIf(process.platform === 'win32')('reviewed recipe scripts through the real native interpreter', () => {
    it('completes large-output installer bodies and checks without retaining their output', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recipe-script-output-')); roots.push(root);
        const marker = join(root, 'installed');
        // Each stream exceeds execFile's default 1 MiB buffer. The native
        // script contract consumes only exit status, never these output bytes.
        const noisy = 'dd if=/dev/zero bs=1048576 count=2 2>/dev/null\ndd if=/dev/zero bs=1048576 count=2 >&2 2>/dev/null\n';
        const step = MachineRecipeStepV1Schema.parse({ id: 'install', kind: 'script', shell: 'sh',
            body: `${noisy}printf complete > '${marker}'\n`,
            check: { body: `${noisy}test -e '${marker}'\n`, unsatisfiedExitCodes: [1] } });
        const outputs: Awaited<ReturnType<typeof runMachineSetupNativeCommand>>[] = [];
        const backend = createMachineSetupNativeBackend({ run: async command => {
            const result = await runMachineSetupNativeCommand(command);
            outputs.push(result);
            return result;
        } });
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        expect(outputs[0]).toEqual({ code: 1, stdout: '', stderr: '' });
        expect(plan.nativeFacts).toEqual([{ stepId: 'install', status: 'drifted', facts: { exitCode: 1 } }]);
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['install'] });
        expect(await readFile(marker, 'utf8')).toBe('complete');
        expect(await checkMachineSetupEffectPlan({ basis, steps: [step], backend })).toMatchObject({
            nativeFacts: [{ stepId: 'install', status: 'satisfied', facts: { exitCode: 0 } }],
        });
        for (const result of outputs) {
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
            expect(result.errorCode).toBeUndefined();
        }
    });
    it('reconciles the native footprint then restores vendor mode on every Apply even when installation is already satisfied', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recipe-reapply-')); roots.push(root);
        const path = join(root, 'vendor');
        const marker = join(path, 'installed');
        const group = await runMachineSetupNativeCommand({ executable: 'id', args: ['-gn'] });
        expect(group.code).toBe(0);
        const steps = [
            { id: 'data', kind: 'directory', path, owner: userInfo().username, group: group.stdout.trim(), mode: 0o755 },
            { id: 'vendor-mode', kind: 'script', shell: 'sh', body: `chmod 700 '${path}'\n` },
            { id: 'install', kind: 'script', shell: 'sh', body: `printf installed >> '${marker}'\n`,
                check: { body: `test -e '${marker}'\n`, unsatisfiedExitCodes: [1] } },
        ].map(step => MachineRecipeStepV1Schema.parse(step));
        const backend = createMachineSetupNativeBackend();
        for (let apply = 0; apply < 2; apply++) {
            const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
            expect(readMachineSetupInitialPresenceV1(plan)).toBe(apply === 0 ? 'absent' : 'present');
            expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
            expect((await stat(path)).mode & 0o777).toBe(0o700);
            expect(await readFile(marker, 'utf8')).toBe('installed');
        }
    });
    it('uses the existing native footprint for first-presence and never invents presence from a script check', () => {
        const script = MachineRecipeStepV1Schema.parse({ id: 'installer', kind: 'script', shell: 'sh', body: 'true\n' });
        const directory = MachineRecipeStepV1Schema.parse({ id: 'footprint', kind: 'directory', path: '/example/vendor', owner: 'root', group: 'root', mode: 0o755 });
        const plan = (present: boolean) => createMachineSetupEffectPlan({ basis, steps: [directory, script], nativeFacts: [
            { stepId: directory.id, status: present ? 'satisfied' : 'drifted', facts: { present } },
            { stepId: script.id, status: 'drifted', facts: {} },
        ] });
        expect(readMachineSetupInitialPresenceV1(plan(false))).toBe('absent');
        expect(readMachineSetupInitialPresenceV1(plan(true))).toBe('present');
        expect(readMachineSetupInitialPresenceV1(createMachineSetupEffectPlan({ basis, steps: [script],
            nativeFacts: [{ stepId: script.id, status: 'drifted', facts: {} }] }))).toBeUndefined();
    });
    it('executes exact stdin bytes, verifies the check, covers both bodies in the digest, and skips a settled install', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recipe-script-')); roots.push(root);
        const path = join(root, 'installed');
        const body = `printf '%s\\n' 'literal $HOME {kind:input,path:never}' >> '${path}'\n`;
        const step = MachineRecipeStepV1Schema.parse({ id: 'install', kind: 'script', shell: 'bash', body,
            check: { body: `test -e '${path}'\n`, unsatisfiedExitCodes: [1] } });
        const backend = createMachineSetupNativeBackend();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        const altered = MachineRecipeStepV1Schema.parse({ ...step, body: body + '\n' });
        const alteredCheck = MachineRecipeStepV1Schema.parse({ ...step, check: { body: 'true\n', unsatisfiedExitCodes: [1] } });
        expect((await checkMachineSetupEffectPlan({ basis, steps: [altered], backend })).planDigest).not.toBe(plan.planDigest);
        expect((await checkMachineSetupEffectPlan({ basis, steps: [alteredCheck], backend })).planDigest).not.toBe(plan.planDigest);
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['install'] });
        expect(await readFile(path, 'utf8')).toBe('literal $HOME {kind:input,path:never}\n');
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(await readFile(path, 'utf8')).toBe('literal $HOME {kind:input,path:never}\n');
    });

    it('settles no-check success, script failure, failed verification and unavailable checks through existing results', async () => {
        for (const [body, check, status] of [
            ['true\n', undefined, 'applied'], ['exit 4\n', undefined, 'failed'],
            ['true\n', { body: 'exit 1\n', unsatisfiedExitCodes: [1] }, 'failed'],
            ['true\n', { body: 'exit 8\n', unsatisfiedExitCodes: [1] }, 'unavailable'],
        ] as const) {
            const step = MachineRecipeStepV1Schema.parse({ id: 'script', kind: 'script', shell: 'sh', body, ...(check ? { check } : {}) });
            const backend = createMachineSetupNativeBackend();
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
            expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status });
        }
    });
});
