import { mkdtemp, readFile, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMachineSetupEffectPlan, applyMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

// Wrap the genuine OS namespace so ESM fixtures can project privileged
// metadata without spying on Node's non-configurable native exports.
vi.mock('node:fs/promises', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-setup-writer-')); roots.push(root);
    const path = join(root, 'sudoers');
    const calls: MachineSetupNativeCommand[] = [];
    let valid = true;
    // Native process/identity is the boundary. File staging, ownership checks,
    // digest/currentness and atomic activation run against a real filesystem.
    const runNative = async (command: MachineSetupNativeCommand) => {
        calls.push(command);
        if (command.executable === 'id') return { code: 0, stdout: `${command.args[0] === '-u' ? process.getuid?.() : process.getgid?.()}\n`, stderr: '' };
        if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
            ? `${command.args.at(-1)}:x:${process.getuid?.()}:${process.getgid?.()}::/home/test:/bin/sh\n`
            : `${command.args.at(-1)}:x:${process.getgid?.()}:\n`, stderr: '' };
        if (command.executable === 'visudo') {
            expect(await readFile(command.args[1]!, 'utf8')).toContain('NOPASSWD');
            expect(await lstat(command.args[1]!)).toMatchObject({ mode: expect.any(Number) });
            return { code: valid ? 0 : 1, stdout: '', stderr: 'native diagnostic is not a public event' };
        }
        throw new Error(`Unexpected process: ${command.executable}`);
    };
    const backend = createMachineSetupNativeBackend({ run: runNative });
    const step: MachineRecipeStepV1 = { id: 'sudoers', kind: 'file', path, owner: userInfo().username, group: userInfo().username,
        mode: 0o440, content: { kind: 'literal', value: '# Happier managed administrator access\nhappier ALL=(ALL:ALL) NOPASSWD: ALL\n' }, validate: 'sudoers' };
    return { root, path, calls, backend, step, runNative, rejectValidation: () => { valid = false; } };
}
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };

async function rootSecretFixture() {
    const f = await fixture();
    const actualLstat = filesystem.lstat;
    const ownership = new Map<string, { uid: number; gid: number }>();
    const ancestors = new Set<string>();
    for (let path = f.root; ; path = dirname(path)) { ancestors.add(path); if (dirname(path) === path) break; }
    // Only privileged OS attributes differ from this unprivileged temporary
    // filesystem. Real inode/content/mode/symlink and activation behavior stay.
    vi.spyOn(filesystem, 'lstat').mockImplementation(async (path, options) => {
        const stat = await actualLstat(path, options), name = String(path);
        const ancestor = ancestors.has(name), inside = name.startsWith(f.root + sep);
        const owner = ownership.get(stat.ino.toString()) ?? (ancestor || inside && stat.isDirectory() ? { uid: 0, gid: 0 } : undefined);
        const mode = ancestor ? Number(stat.mode) & ~0o022 : Number(stat.mode);
        return Object.assign(stat, { ...(owner ? { uid: typeof stat.uid === 'bigint' ? BigInt(owner.uid) : owner.uid,
            gid: typeof stat.gid === 'bigint' ? BigInt(owner.gid) : owner.gid } : {}), mode: typeof stat.mode === 'bigint' ? BigInt(mode) : mode });
    });
    vi.spyOn(filesystem, 'chown').mockImplementation(async (path, uid, gid) => { ownership.set((await actualLstat(path)).ino.toString(), { uid, gid }); });
    return { ...f, step: { ...f.step, owner: 'root', group: 'root' },
        runNative: async (command: MachineSetupNativeCommand) => command.executable === 'getent'
            ? { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' }
            : f.runNative(command) };
}

describe('machine setup native file boundary', () => {
    it.each(['match', 'mismatch', 'missing'] as const)('retires a protected secret-grant file only from the expected private bytes (%s)', async scenario => {
        const f = await rootSecretFixture();
        const secret = 'native-private-retirement-fixture';
        const materialized: Uint8Array[] = [];
        const backend = createMachineSetupNativeBackend({ run: f.runNative,
            async materializeSecretGrant(grantRef) {
                expect(grantRef).toBe('retirement-grant');
                const bytes = Buffer.from(secret); materialized.push(bytes);
                return { bytes, async assertCurrent() {}, dispose() { bytes.fill(0); } };
            } });
        const installed: MachineRecipeStepV1 = { id: 'connector-token', kind: 'file', path: f.path,
            owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'secretGrant', grantRef: 'retirement-grant' } };
        if (scenario !== 'missing') {
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [installed], backend });
            expect((await applyMachineSetupEffectPlan({ plan, backend })).status).toBe('applied');
            if (scenario === 'mismatch') await writeFile(f.path, 'foreign-private-file');
        }
        const removed: MachineRecipeStepV1 = { ...installed, state: 'absent' };
        const observed = await backend.observe(removed);
        expect(observed).toMatchObject(scenario === 'mismatch'
            ? { status: 'unavailable', reason: 'foreign_effect_conflict' }
            : { status: scenario === 'missing' ? 'satisfied' : 'drifted', facts: { present: scenario !== 'missing' } });
        expect(observed.facts).not.toHaveProperty('contentDigest');
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [removed], backend });
        const result = await applyMachineSetupEffectPlan({ plan, backend });
        expect(result.status).toBe(scenario === 'mismatch' ? 'unavailable' : 'applied');
        if (scenario === 'mismatch') expect(await readFile(f.path, 'utf8')).toBe('foreign-private-file');
        else await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        const outward = JSON.stringify({ observed, plan, result, calls: f.calls });
        expect(outward.includes(secret)).toBe(false);
        expect(outward.includes(createHash('sha256').update(secret).digest('hex'))).toBe(false);
        expect(materialized.length).toBeGreaterThan(0);
        expect(materialized.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    });

    it('materializes admitted secret grants privately without secret-derived plan facts and preserves identical native files', async () => {
        const f = await rootSecretFixture();
        const secret = 'native-secret-grant-test-value';
        const materialized: Uint8Array[] = [];
        const options = {
            run: f.runNative,
            async materializeSecretGrant(grantRef: string) {
                expect(grantRef).toBe('opaque-grant-reference');
                const bytes = Buffer.from(secret);
                materialized.push(bytes);
                return { bytes, async assertCurrent() {}, dispose() { bytes.fill(0); } };
            },
        };
        const backend = createMachineSetupNativeBackend(options);
        const step: MachineRecipeStepV1 = { id: 'connector-token', kind: 'file', path: f.path,
            owner: f.step.owner, group: f.step.group, mode: 0o600,
            content: { kind: 'secretGrant', grantRef: 'opaque-grant-reference' } };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        expect(plan.nativeFacts[0]?.status).toBe('drifted');
        const progress: unknown[] = [];
        const result = await applyMachineSetupEffectPlan({ plan, backend,
            onProgress: event => progress.push(event) });
        expect(result.status).toBe('applied');
        expect((await readFile(f.path, 'utf8')) === secret).toBe(true);
        expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
        const first = await lstat(f.path);
        const current = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        expect(current.nativeFacts[0]?.status).toBe('satisfied');
        expect(current.nativeFacts[0]?.facts).not.toHaveProperty('contentDigest');
        expect((await applyMachineSetupEffectPlan({ plan: current, backend })).status).toBe('applied');
        expect((await lstat(f.path)).ino).toBe(first.ino);
        const outward = JSON.stringify({ plan, current, result, progress, calls: f.calls });
        expect(outward.includes(secret)).toBe(false);
        expect(outward.includes(createHash('sha256').update(secret).digest('hex'))).toBe(false);
        expect(materialized.length).toBeGreaterThan(0);
        expect(materialized.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    });

    it('refuses the fixed firewall artifact before filesystem access or a grant opening', async () => {
        const f = await rootSecretFixture();
        // The OS boundary must remain unreachable for a portable declaration of this fixed artifact.
        const inspect = vi.spyOn(filesystem, 'lstat').mockRejectedValue(new Error('Fixed artifact reached the file boundary'));
        const open = vi.fn(async () => { throw new Error('Fixed artifact reached the grant boundary'); });
        const backend = createMachineSetupNativeBackend({ run: f.runNative, materializeSecretGrant: open });
        await expect(backend.apply({ id: 'fixed', kind: 'file', path: '/etc/happier/firewall/rules.nft',
            owner: 'root', group: 'root', mode: 0o600, content: { kind: 'secretGrant', grantRef: 'grant' } }))
            .rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(inspect).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    it('uses one opened material for the native comparison and removal', async () => {
        const f = await rootSecretFixture();
        const materialized: Uint8Array[] = [];
        const backend = createMachineSetupNativeBackend({ run: f.runNative,
            async materializeSecretGrant() {
                const bytes = Buffer.from('single-opening-fixture'); materialized.push(bytes);
                return { bytes, async assertCurrent() {}, dispose() { bytes.fill(0); } };
            } });
        const step: MachineRecipeStepV1 = { id: 'connector', kind: 'file', path: f.path,
            owner: 'root', group: 'root', mode: 0o600, content: { kind: 'secretGrant', grantRef: 'grant' } };
        await backend.apply(step);
        const beforeRemoval = materialized.length;
        await backend.apply({ ...step, state: 'absent' });
        expect(materialized.length - beforeRemoval).toBe(1);
        await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(materialized.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    });

    it('disposes retired grants before writing and refuses public modes or symbolic-link destinations', async () => {
        const f = await rootSecretFixture();
        const materialized: Uint8Array[] = [];
        let current = true;
        const backend = createMachineSetupNativeBackend({ run: f.runNative,
            async materializeSecretGrant() {
                const bytes = Buffer.from('private-connector-fixture'); materialized.push(bytes);
                return { bytes, async assertCurrent() { if (!current) throw new Error('retired'); }, dispose() { bytes.fill(0); } };
            } });
        const step: MachineRecipeStepV1 = { ...f.step, id: 'connector', mode: 0o600, validate: undefined,
            content: { kind: 'secretGrant', grantRef: 'grant' } };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        current = false;
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'unavailable', completedStepIds: [], reason: 'required_fact_unavailable' });
        await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        current = true;
        expect(await backend.observe({ ...step, mode: 0o644 })).toMatchObject({ status: 'unavailable' });
        const target = join(f.root, 'foreign'); await writeFile(target, 'foreign'); await symlink(target, f.path);
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(await readFile(target, 'utf8')).toBe('foreign');
        expect(materialized.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    });

    it('validates a protected candidate before activation and a fresh identical apply performs no write or validator process', async () => {
        const f = await fixture();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect((await lstat(f.path)).mode & 0o777).toBe(0o440);
        const before = await lstat(f.path);
        const validations = f.calls.filter(c => c.executable === 'visudo').length;
        const again = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan: again, backend: f.backend })).status).toBe('applied');
        expect((await lstat(f.path)).ino).toBe(before.ino);
        expect(f.calls.filter(c => c.executable === 'visudo')).toHaveLength(validations);
    });

    it('preserves foreign files and symlinks, and validation failure never activates the candidate', async () => {
        const f = await fixture();
        await writeFile(f.path, 'foreign policy');
        let plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('unavailable');
        expect(await readFile(f.path, 'utf8')).toBe('foreign policy');
        await rm(f.path);
        f.rejectValidation();
        plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('failed');
        await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        const target = join(f.root, 'target'); await writeFile(target, 'foreign target'); await symlink(target, f.path);
        plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('unavailable');
        expect(await readFile(target, 'utf8')).toBe('foreign target');
    });
});
