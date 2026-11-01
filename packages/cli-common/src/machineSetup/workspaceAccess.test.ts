import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineRecipeStepV1 } from './index.js';

describe('reviewed workspace access at the setup interpreter', () => {
    it.skipIf(process.platform !== 'linux')('distinguishes an absent traversal parent from a symlink at the target or an ancestor', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-traversal-parent-'));
        try {
            const missing = join(root, 'missing', 'parent');
            const targetLink = join(root, 'target-link'), ancestorLink = join(root, 'ancestor-link');
            await symlink(join(root, 'absent'), targetLink);
            await symlink(root, ancestorLink);
            const backend = createMachineSetupNativeBackend({ run: async () => { throw new Error('No native commands before path qualification'); } });
            const step: MachineRecipeStepV1 = { id: 'traversal', kind: 'pathTraversal', path: missing, agentUsername: 'member' };
            expect(await backend.observe(step)).toMatchObject({ status: 'drifted', facts: { present: false } });
            expect(await backend.observe({ ...step, path: targetLink })).toMatchObject({ status: 'unavailable' });
            expect(await backend.observe({ ...step, path: join(ancestorLink, 'missing') })).toMatchObject({ status: 'unavailable' });
            await expect(backend.apply(step)).rejects.toBeDefined();
            await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.skipIf(process.platform !== 'linux')('converges a plain admitted Workspace without configuring a nonexistent Git repository', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plain-workspace-'));
        try {
            await chmod(root, 0o700);
            const file = join(root, 'note');
            await writeFile(file, 'plain Workspace', { mode: 0o600 });
            let gitCalls = 0;
            const backend = createMachineSetupNativeBackend({ run: async ({ executable, args }) => {
                if (executable === 'getent') return { code: 0, stdout: args.includes('group')
                    ? `happier-workspace:x:${process.getgid!()}:\n`
                    : `happier-agent:x:${process.getuid!()}:${process.getgid!()}::${root}:/usr/sbin/nologin\n`, stderr: '' };
                if (executable === 'runuser') {
                    gitCalls++;
                    // Genuine Git boundary: global trust can be empty anywhere,
                    // but config --local fails outside a repository.
                    return args.includes('--global') ? { code: 1, stdout: '', stderr: '' }
                        : { code: 128, stdout: '', stderr: 'fatal: --local can only be used inside a git repository' };
                }
                throw new Error(`Unexpected OS command ${executable}`);
            } });
            const basis = { kind: 'agentIsolation' as const, machineId: 'machine', enabled: true, expectedPolicy: { enabled: true } };
            const steps: MachineRecipeStepV1[] = [{ id: 'plain', kind: 'workspaceAccess', path: root,
                group: 'happier-workspace', agentUsername: 'happier-agent' }];
            const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
            await expect(applyMachineSetupEffectPlan({ plan, backend })).resolves.toMatchObject({ status: 'applied' });
            expect((await lstat(root)).mode & 0o2070).toBe(0o2070);
            expect((await lstat(file)).mode & 0o660).toBe(0o660);
            const settled = await checkMachineSetupEffectPlan({ basis, steps, backend });
            expect(settled.nativeFacts[0]).toMatchObject({ status: 'satisfied', facts: { gitMetadata: false, sharedGit: null, trusted: null } });
            await expect(applyMachineSetupEffectPlan({ plan: settled, backend })).resolves.toMatchObject({ status: 'applied' });
            expect(gitCalls).toBe(0);
            // A newly initialized checkout is a new effect basis, not a silent
            // exemption from the existing Git configuration review.
            await mkdir(join(root, '.git'));
            expect((await applyMachineSetupEffectPlan({ plan: settled, backend })).status).toBe('plan_changed');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.skipIf(process.platform !== 'linux')('preserves owners and executable bits, shares only the admitted tree and rejects changed identity before effects', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-workspace-access-'));
        try {
            const checkout = join(root, 'checkout'), outside = join(root, 'outside');
            await mkdir(checkout); await mkdir(outside); await mkdir(join(checkout, '.git'));
            await writeFile(join(checkout, 'script'), 'selected'); await chmod(join(checkout, 'script'), 0o4700);
            await writeFile(join(outside, 'private'), 'outside'); await chmod(join(outside, 'private'), 0o600);
            await symlink(outside, join(checkout, 'outside'));
            let sharedGit = false, trusted = false;
            const run = async (input: { executable: string; args: readonly string[] }) => {
                const { executable, args } = input;
                if (executable === 'git') throw new Error('Workspace-controlled Git must not run as root');
                if (executable === 'getent') return { code: 0, stdout: args.includes('group')
                    ? `happier-workspace:x:${process.getgid!()}:\n`
                    : `happier-agent:x:${process.getuid!()}:${process.getgid!()}::${root}:/usr/sbin/nologin\n`, stderr: '' };
                if (executable === 'runuser') {
                    if (args.includes('--add')) trusted = true;
                    if (args.at(-1) === 'group') sharedGit = true;
                    const value = args.includes('safe.directory') ? (trusted ? checkout : '') : (sharedGit ? 'group' : '');
                    return { code: args.includes('--get-all') || args.includes('--get') ? (value ? 0 : 1) : 0, stdout: value + '\n', stderr: '' };
                }
                throw new Error(`Unexpected OS command ${executable}`);
            };
            const step: MachineRecipeStepV1 = { id: 'checkout', kind: 'workspaceAccess', path: checkout,
                group: 'happier-workspace', agentUsername: 'happier-agent' };
            const backend = createMachineSetupNativeBackend({ run });
            const basis = { kind: 'agentIsolation' as const, machineId: 'machine', enabled: true, expectedPolicy: { enabled: false } };
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
            expect(plan.nativeFacts[0]?.status).toBe('drifted');
            expect((await applyMachineSetupEffectPlan({ plan, backend })).status).toBe('applied');
            expect((await lstat(join(checkout, 'script'))).mode & 0o7777).toBe(0o770);
            expect((await lstat(checkout)).mode & 0o2070).toBe(0o2070);
            expect((await lstat(checkout)).uid).toBe(process.getuid!());
            expect((await lstat(join(outside, 'private'))).mode & 0o777).toBe(0o600);
            expect(await readFile(join(checkout, 'script'), 'utf8')).toBe('selected');
            expect((await checkMachineSetupEffectPlan({ basis, steps: [step], backend })).nativeFacts[0]?.status).toBe('satisfied');
            const reviewed = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
            await writeFile(join(checkout, 'new'), 'new');
            expect((await applyMachineSetupEffectPlan({ plan: reviewed, backend })).status).toBe('plan_changed');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
