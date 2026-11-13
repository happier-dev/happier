import { lstat, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Transform } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';
import type { MachineAdminAccessObservationV1, MachineAdminAccessV1 } from '@happier-dev/protocol';
import { createMachineAdminAccessHost } from './machineAdminAccessHost';
import type { MachineElevationDependencies, MachineElevationSpawn } from './runElevatedEffect';
import { buildManagedSudoersSteps, MANAGED_SUDOERS_PATH } from './managedSudoers';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';
import { observeMachineAdminAccess } from './observeMachineAdminAccess';

const redirected = vi.hoisted(() => ({ directory: '' }));
// Protected native filesystem is the boundary. Every operation still uses the
// real filesystem, canonical file backend, root parser and digest interpreter.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const { redirectSudoersFileSystem } = await import('./sudoersFileSystem.testkit');
    return redirectSudoersFileSystem(actual, () => redirected.directory);
});

const nativeUid = process.getuid?.() ?? 0, nativeGid = process.getgid?.() ?? 0;
const none = { version: 1, mode: 'none' } as const;
const ask = { version: 1, mode: 'ask', administratorUsername: 'ops.admin' } as const;
const preauthorized = { version: 1, mode: 'preauthorized' } as const;
const observation: MachineAdminAccessObservationV1 = { version: 1, observedAt: 1, daemonUid: 1001,
    daemonUsername: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
    passwordlessSudoToRoot: 'denied', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(previousPolicy: MachineAdminAccessV1, policy: MachineAdminAccessV1, daemonUsername: string | null = 'happier',
    sudoImplementation: 'classic' | 'sudo-rs' = 'classic') {
    const root = await mkdtemp(join(tmpdir(), 'happier-admin-host-')); roots.push(root); redirected.directory = root;
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    if (previousPolicy.mode !== 'none' && !daemonUsername) throw new Error('Previous grant fixture needs a known daemon');
    const [previous] = previousPolicy.mode === 'none' ? []
        : buildManagedSudoersSteps({ daemonUsername: daemonUsername!, previousPolicy: none, policy: previousPolicy });
    if (previous?.content?.kind === 'literal') {
        await writeFile(MANAGED_SUDOERS_PATH, previous.content.value, { mode: 0o600 });
        await chmod(MANAGED_SUDOERS_PATH, 0o440);
    }
    const launches: Parameters<MachineElevationSpawn>[0][] = [], passwords: string[] = [], requests: unknown[] = [];
    const nativeFailures: unknown[] = [], records: unknown[] = [];
    let rootAllowed = previousPolicy.mode === 'preauthorized', current = true;
    let beforeApply: () => Promise<void> = async () => {};
    let loseResult = false;
    const spawn: MachineElevationSpawn = invocation => {
        launches.push(invocation);
        const stdin = new PassThrough(), rootInput = new PassThrough(), rootOutput = new PassThrough(), stderr = new PassThrough();
        const controller = new AbortController();
        let close!: (result: { code: number | null; signal: string | null }) => void;
        const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { close = resolve; });
        const stdout = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            void (async () => {
                const record: unknown = JSON.parse(chunk.toString('utf8'));
                records.push(record);
                if (record && typeof record === 'object' && 'type' in record && record.type === 'ready') await beforeApply();
                if (record && typeof record === 'object' && 'type' in record && record.type === 'result' && 'result' in record
                    && record.result && typeof record.result === 'object' && 'status' in record.result) {
                    if (loseResult) { callback(); return; }
                }
                callback(null, JSON.stringify(record) + '\n');
            })().catch(error => callback(error));
        } });
        rootOutput.pipe(stdout);
        // Sudo consumes only its authentication frame. The installed root entry
        // receives the remaining request frames through its production parser.
        void (async () => {
            const lines = createInterface({ input: stdin, crlfDelay: Infinity });
            const iterator = lines[Symbol.asyncIterator]();
            if (invocation.args.includes('-S')) {
                if (previousPolicy.mode !== 'ask') throw new Error('Only Ask requests native authentication');
                const administrator = previousPolicy.administratorUsername;
                if (invocation.args[invocation.args.indexOf('-u') + 1] !== administrator) {
                    throw new Error('The native password principal must be the selected administrator');
                }
                const separator = invocation.args.indexOf('--');
                const inner = invocation.args.slice(separator + 1);
                if (inner[0] !== 'sudo' || !inner.includes('-S') || inner[inner.indexOf('-u') + 1] !== 'root') {
                    throw new Error('Ask needs both native sudo hops');
                }
                for (const args of [invocation.args, inner]) {
                    const prompt = args[args.indexOf('-p') + 1]?.replace('%p', administrator);
                    if (!prompt) throw new Error('Expected a named sudo password prompt');
                    // sudo-rs 0.2.13 converse.rs wraps the custom prompt in
                    // PAM's label; rpassword.rs emits a newline after input.
                    // Preserve those actual bytes through the host readline.
                    stderr.write(sudoImplementation === 'sudo-rs' ? `[sudo: ${prompt}] Password: ` : prompt);
                    const answer = await iterator.next(); passwords.push(answer.value ?? '');
                    stderr.write('\n');
                    if (answer.done || answer.value !== 'one-use-password') throw new Error('Authentication denied');
                }
            }
            const running = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
                stdin: rootInput, stdout: rootOutput, signal: controller.signal,
                runNative: async command => {
                    if (command.executable === 'getent') return { code: 0, stderr: '', stdout: command.args.includes('passwd')
                        ? `root:x:${nativeUid}:${nativeGid}::/root:/bin/sh\n` : `root:x:${nativeGid}:\n` };
                    if (command.executable === 'visudo') return { code: 0, stdout: '', stderr: '' };
                    throw new Error('Unexpected root native command');
                },
            });
            for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
                requests.push(JSON.parse(line)); rootInput.write(line + '\n');
            }
            rootInput.end();
            const code = await running;
            rootOutput.end(); stderr.end(); close({ code, signal: null });
        })().catch(error => { nativeFailures.push(error); rootInput.destroy(); rootOutput.end(); stderr.end(); close({ code: 1, signal: null }); });
        return { stdin, stdout, stderr, settled, async terminate() {
            controller.abort(); stdin.end(); await settled;
        } };
    };
    const dependencies: Omit<MachineElevationDependencies, 'verifyCurrent'> = { installationId: 'installation-a',
        installedCli: '/opt/happier/current/happier', readPolicy: async () => policy,
        observe: async () => ({ ...observation, daemonUsername, passwordlessSudoToRoot: rootAllowed ? 'allowed' : 'denied' }), spawn };
    const input = { machineId: 'machine-a', operationId: 'admin-operation', previousPolicy, policy, verifyCurrent: async () => current };
    return { input, dependencies, requests, launches, passwords, nativeFailures, records,
        allowRoot: () => { rootAllowed = true; }, denyRoot: () => { rootAllowed = false; }, loseResult: () => { loseResult = true; },
        onReady: (callback: () => Promise<void>) => { beforeApply = callback; }, retire: () => { current = false; } };
}

// Exercise the canonical observation owner beneath native identity/file adapters.
function observeOwnedGrant(unreadable = false) {
    return observeMachineAdminAccess({ platform: 'linux',
        execFile: async (file, args) => {
            if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : 'happier\n' };
            throw Object.assign(new Error('No standing root grant'), { code: 1 });
        },
        fileSystem: {
            lstat: async path => {
                const stat = await lstat(path);
                return { uid: 0, gid: 0, mode: stat.mode, isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
            },
            readFile: async path => {
                if (unreadable) throw Object.assign(new Error('Protected policy unreadable'), { code: 'EACCES' });
                return readFile(path, 'utf8');
            },
        },
    });
}

describe.runIf(process.platform !== 'win32')('administrator policy host reconciliation', () => {
    it.each([preauthorized, ask])('grants $mode to the observed existing-user daemon through the root interpreter', async policy => {
        const f = await fixture(none, policy, 'alice');
        f.allowRoot();
        let authorityReads = 0;
        expect(await createMachineAdminAccessHost(f.dependencies).reconcile({ ...f.input,
            verifyCurrent: async () => { authorityReads++; return await f.input.verifyCurrent(); },
        })).toMatchObject({ outcome: 'applied' });
        expect(f.nativeFailures).toEqual([]);
        expect(authorityReads).toBe(3);
        expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toBe(policy.mode === 'preauthorized'
            ? 'alice ALL=(ALL:ALL) NOPASSWD: ALL\n'
            : 'Defaults:alice targetpw, timestamp_timeout=0\nalice ALL=(ops.admin) PASSWD: ALL\n');
    });

    it('refuses an Ask transition to the daemon account before spawning or writing a grant', async () => {
        const f = await fixture(none, ask, ask.administratorUsername);
        f.allowRoot();
        expect(await createMachineAdminAccessHost(f.dependencies).reconcile(f.input)).toMatchObject({
            outcome: 'not_applied', reasonCode: 'native_check_unavailable',
            failure: { kind: 'native_check_unavailable', requiredFact: 'distinctAdministrator' },
        });
        expect(f.launches).toEqual([]);
        expect(f.requests).toEqual([]);
        await expect(readFile(MANAGED_SUDOERS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses an unknown daemon principal before spawning or writing a grant', async () => {
        const f = await fixture(none, preauthorized, null);
        f.allowRoot();
        expect(await createMachineAdminAccessHost(f.dependencies).reconcile(f.input))
            .toEqual({ outcome: 'not_applied', reasonCode: 'denied' });
        expect(f.launches).toEqual([]);
        await expect(readFile(MANAGED_SUDOERS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['classic', 'sudo-rs'] as const)('authenticates both %s hops for the selected administrator before one admitted APPLY', async implementation => {
        const policy = { version: 1, mode: 'ask', administratorUsername: 'happier-bootstrap' } as const;
        const f = await fixture(policy, preauthorized, 'happier', implementation), runner = createSystemTasksRunner({ kinds: {} });
        await runner.startAdmitted({ taskId: 'admin-operation', kind: 'machine.setup.apply.v1', params: {} }, { run: async ctx =>
            createMachineAdminAccessHost({ ...f.dependencies, prompt: ctx.prompt, emit: ctx.emit }).reconcile({ ...f.input, signal: ctx.signal }) });
        await new Promise(resolve => setImmediate(resolve));
        expect((await runner.poll({ taskId: 'admin-operation', cursor: 0 })).pendingPrompt?.kind).toBe('sudo.password');
        await runner.respond({ taskId: 'admin-operation', expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' } });
        expect(await runner.wait({ taskId: 'admin-operation' })).toMatchObject({ ok: true, data: { outcome: 'applied' } });
        expect(f.nativeFailures).toEqual([]);
        expect(f.launches).toHaveLength(1); expect(f.passwords).toEqual(['one-use-password', 'one-use-password']);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ mode: 'apply', machineId: f.input.machineId,
            installationId: 'installation-a', operationId: f.input.operationId });
        expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toContain('NOPASSWD');
        expect(JSON.stringify(await runner.poll({ taskId: 'admin-operation', cursor: 0 }))).not.toContain('one-use-password');
    });

    it('requires the previous observed root capability and revokes only the exact previous grant', async () => {
        const f = await fixture(preauthorized, none);
        f.denyRoot();
        expect(await createMachineAdminAccessHost(f.dependencies).reconcile(f.input)).toMatchObject({ outcome: 'not_applied', reasonCode: 'not_preauthorized' });
        expect(f.launches).toEqual([]);
        const admitted = await fixture(preauthorized, none);
        const removed = await createMachineAdminAccessHost(admitted.dependencies).reconcile(admitted.input);
        expect(removed, JSON.stringify(admitted.records)).toMatchObject({ outcome: 'applied' });
        expect(admitted.launches).toHaveLength(1); expect(admitted.launches[0]?.args).toContain('-n');
        await expect(readFile(MANAGED_SUDOERS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const foreign = await fixture(preauthorized, none);
        await chmod(MANAGED_SUDOERS_PATH, 0o600); await writeFile(MANAGED_SUDOERS_PATH, 'foreign root grant\n'); await chmod(MANAGED_SUDOERS_PATH, 0o440);
        expect(await createMachineAdminAccessHost(foreign.dependencies).reconcile(foreign.input)).toMatchObject({
            outcome: 'not_applied', reasonCode: 'native_check_unavailable',
            failure: { kind: 'native_check_unavailable', reason: 'foreign_effect_conflict' },
        });
        expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toBe('foreign root grant\n');
    });

    it('uses no privileged child for None to None and never fabricates unavailable observations', async () => {
        const f = await fixture(none, none);
        const dependencies = { ...f.dependencies, observe: () => observeOwnedGrant() };
        await expect(readFile(MANAGED_SUDOERS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await createMachineAdminAccessHost(dependencies).reconcile(f.input))
            .toMatchObject({ outcome: 'applied', observation: { managedDropIn: 'absent' } });
        expect(f.launches).toEqual([]);
        expect(await createMachineAdminAccessHost({ ...dependencies, observe: async () => { throw new Error('unavailable'); } }).reconcile(f.input))
            .toMatchObject({ outcome: 'not_applied', reasonCode: 'denied' });
        expect(await createMachineAdminAccessHost(dependencies).inspect())
            .toMatchObject({ observation: { managedDropIn: 'absent' }, checkedAt: expect.any(Number) });
    });

    it('refuses a None retry while the prior owned grant remains valid, invalid or unreadable', async () => {
        const f = await fixture(none, none);
        const [grant] = buildManagedSudoersSteps({ daemonUsername: 'happier', previousPolicy: none, policy: preauthorized });
        if (grant?.content?.kind !== 'literal') throw new Error('Expected the canonical owned grant');
        let bytes = grant.content.value;
        for (const state of ['valid', 'invalid', 'unknown'] as const) {
            if (state === 'invalid') bytes += '# externally modified\n';
            await writeFile(MANAGED_SUDOERS_PATH, bytes, { mode: 0o600 });
            await chmod(MANAGED_SUDOERS_PATH, 0o440);
            const dependencies = { ...f.dependencies, observe: () => observeOwnedGrant(state === 'unknown') };
            expect((await dependencies.observe()).managedDropIn).toBe(state);
            expect(await createMachineAdminAccessHost(dependencies).reconcile(f.input))
                .toMatchObject({ outcome: 'not_applied', reasonCode: 'denied' });
            expect(f.launches).toEqual([]);
            expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toBe(bytes);
            await chmod(MANAGED_SUDOERS_PATH, 0o600);
        }
    });

    it.each(['currentness', 'facts'] as const)('refuses changed %s before the admitted APPLY or native mutation', async changed => {
        const f = await fixture(preauthorized, ask);
        f.onReady(async () => {
            if (changed === 'currentness') f.retire();
            else { await chmod(MANAGED_SUDOERS_PATH, 0o600); await writeFile(MANAGED_SUDOERS_PATH, 'foreign changed policy\n'); await chmod(MANAGED_SUDOERS_PATH, 0o440); }
        });
        expect(await createMachineAdminAccessHost(f.dependencies).reconcile(f.input)).toMatchObject(changed === 'currentness'
            ? { outcome: 'not_applied', reasonCode: 'plan_stale' }
            : { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                failure: { kind: 'native_check_unavailable', reason: 'foreign_effect_conflict' } });
        expect(f.requests).toHaveLength(changed === 'facts' ? 1 : 0);
        expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toBe(changed === 'facts' ? 'foreign changed policy\n' : 'happier ALL=(ALL:ALL) NOPASSWD: ALL\n');
    });

    it('rejects changed desired policy before authentication and retains a lost terminal as unknown', async () => {
        const stale = await fixture(preauthorized, ask);
        expect(await createMachineAdminAccessHost({ ...stale.dependencies, readPolicy: async () => none }).reconcile(stale.input))
            .toMatchObject({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(stale.launches).toEqual([]);
        const lost = await fixture(preauthorized, ask); lost.loseResult();
        expect(await createMachineAdminAccessHost(lost.dependencies).reconcile(lost.input)).toMatchObject({ outcome: 'outcome_unknown' });
        expect(lost.launches).toHaveLength(1);
        expect(await readFile(MANAGED_SUDOERS_PATH, 'utf8')).toContain('happier ALL=(ops.admin) PASSWD: ALL');
    });
});
