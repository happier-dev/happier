import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import type { MachineAdminAccessV1, MachineRecipeStepV1 } from '@happier-dev/protocol';
import { buildManagedSudoersSteps, recognizeManagedSudoersDropIn } from './managedSudoers';

const none = { version: 1, mode: 'none' } as const;
const preauthorized = { version: 1, mode: 'preauthorized' } as const;
const ask = { version: 1, mode: 'ask', administratorUsername: 'operator.name' } as const;
const preauthorizedBytes = 'happier ALL=(ALL:ALL) NOPASSWD: ALL\n';
const askBytes = 'Defaults:happier targetpw, timestamp_timeout=0\nhappier ALL=(operator.name) PASSWD: ALL\n';
const basis = { kind: 'setup', machineId: 'machine', desiredRevision: 1 } as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(daemonUsername = 'happier') {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-sudoers-'));
    roots.push(root);
    let validations = 0;
    // Only native identity/process/validation are substituted. Root's identity
    // maps to the test user so the real filesystem backend needs no privilege.
    const backend = machineSetup.createMachineSetupNativeBackend({ run: async command => {
        if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
            ? `root:x:${process.getuid!()}:${process.getgid!()}::/root:/bin/sh\n`
            : `root:x:${process.getgid!()}:\n`, stderr: '' };
        if (command.executable === 'visudo') {
            expect(command.args[0]).toBe('-cf');
            const candidate = command.args[1]!;
            expect(recognizeManagedSudoersDropIn(await readFile(candidate, 'utf8'), daemonUsername)).toBe('valid');
            expect((await lstat(candidate)).mode & 0o7777).toBe(0o440);
            validations += 1;
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native process: ${command.executable}`);
    } });
    const steps = (previousPolicy: MachineAdminAccessV1, policy: MachineAdminAccessV1) =>
        buildManagedSudoersSteps({ daemonUsername, previousPolicy, policy }).map(step => {
            expect(step).toMatchObject({ kind: 'file', path: '/etc/sudoers.d/90-happier-daemon', owner: 'root', group: 'root', mode: 0o440 });
            return { ...step, path: join(root, basename(step.path)) };
        });
    const apply = async (steps: MachineRecipeStepV1[]) => {
        const plan = await machineSetup.checkMachineSetupEffectPlan({ basis, steps, backend });
        return machineSetup.applyMachineSetupEffectPlan({ plan, backend });
    };
    return { root, steps, apply, validations: () => validations, path: join(root, '90-happier-daemon') };
}

describe('managed daemon sudoers effect producer', () => {
    it.each([
        { daemonUsername: 'happier', policy: preauthorized, content: preauthorizedBytes, next: ask, nextContent: askBytes },
        { daemonUsername: 'happier', policy: ask, content: askBytes, next: preauthorized, nextContent: preauthorizedBytes },
        { daemonUsername: 'alice', policy: preauthorized, content: preauthorizedBytes.replaceAll('happier', 'alice'),
            next: ask, nextContent: askBytes.replaceAll('happier', 'alice') },
    ])('installs, no-ops, changes and exactly removes $daemonUsername $policy.mode through the shared interpreter', async ({ daemonUsername, policy, content, next, nextContent }) => {
        const f = await fixture(daemonUsername);
        const sibling = join(f.root, '91-happier-agent');
        await writeFile(sibling, 'separate agent RunAs policy\n');
        const install = f.steps(none, policy);
        expect(install).toHaveLength(1);
        expect(install[0]).toMatchObject({ state: 'present', content: { kind: 'literal', value: content }, validate: 'sudoers' });
        expect(await f.apply(install)).toMatchObject({ status: 'applied', completedStepIds: [install[0]!.id] });
        expect(await readFile(f.path, 'utf8')).toBe(content);
        const installed = await lstat(f.path);
        expect(installed.mode & 0o7777).toBe(0o440);
        expect(await f.apply(f.steps(policy, policy))).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect((await lstat(f.path)).ino).toBe(installed.ino);
        expect(f.validations()).toBe(1);
        expect(await f.apply(f.steps(policy, next))).toMatchObject({ status: 'applied' });
        expect(await readFile(f.path, 'utf8')).toBe(nextContent);
        const removal = f.steps(next, none);
        expect(removal).toHaveLength(1);
        expect(removal[0]).toMatchObject({ state: 'absent', expectedContentDigest: createHash('sha256').update(nextContent).digest('hex') });
        expect(removal[0]).not.toHaveProperty('content');
        expect(await f.apply(removal)).toMatchObject({ status: 'applied' });
        await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.validations()).toBe(2);
        expect(await readFile(sibling, 'utf8')).toBe('separate agent RunAs policy\n');
        expect(f.steps(none, none)).toEqual([]);
    });

    it('preserves protected foreign content and symlink targets for both install and exact removal', async () => {
        const f = await fixture();
        const programs = [f.steps(none, preauthorized), f.steps(preauthorized, none)];
        await writeFile(f.path, 'foreign policy\n', { mode: 0o440 });
        for (const steps of programs) {
            expect(await f.apply(steps)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
            expect(await readFile(f.path, 'utf8')).toBe('foreign policy\n');
        }
        await rm(f.path);
        const target = join(f.root, 'foreign-target');
        await writeFile(target, preauthorizedBytes);
        await symlink(target, f.path);
        for (const steps of programs) expect(await f.apply(steps)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe(preauthorizedBytes);
        expect(f.validations()).toBe(0);
    });

    it('recognizes only exact canonical policies and uses the canonical administrator admission', () => {
        expect(recognizeManagedSudoersDropIn(preauthorizedBytes, 'happier')).toBe('valid');
        expect(recognizeManagedSudoersDropIn(askBytes, 'happier')).toBe('valid');
        expect(recognizeManagedSudoersDropIn(preauthorizedBytes, 'alice')).toBe('invalid');
        expect(recognizeManagedSudoersDropIn(askBytes, 'alice')).toBe('invalid');
        for (const content of [preauthorizedBytes.trimEnd(), `${askBytes}root ALL=(ALL:ALL) ALL\n`,
            `${preauthorizedBytes}# foreign addition\n`, askBytes.replace('operator.name', 'root'),
            askBytes.replace('operator.name', 'happier'), askBytes.replace('operator.name', 'operator\nroot')]) {
            expect(recognizeManagedSudoersDropIn(content, 'happier')).toBe('invalid');
        }
        expect(() => buildManagedSudoersSteps({ daemonUsername: 'happier', previousPolicy: none,
            policy: { version: 1, mode: 'ask', administratorUsername: 'operator\nroot ALL=(ALL:ALL) ALL' } })).toThrow();
    });
});
