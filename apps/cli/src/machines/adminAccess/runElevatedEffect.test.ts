import { PassThrough, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/deployment-protocol';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';
import { machineSetup } from '@happier-dev/cli-common';
import type { MachineAdminAccessObservationV1, MachineRecipeStepV1 } from '@happier-dev/protocol';
import { checkElevatedMachineSetupPlanResult, checkElevatedMachineSetupPlan, runElevatedEffect, runElevatedMachineReboot, runElevatedMachineSetupIntent, prepareMachinePoweroff, type MachineElevationSpawn, type MachineElevationDependencies } from './runElevatedEffect';
import { MachineEffectInternalRequestSchema } from '../setup/effectInternalProtocol';
import { inspectMachineReachabilityNativeFirewall } from '../reachability/inspectMachineReachabilityNativeFirewall';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';
import { MachineElevatedEffectV1Schema, MachineSetupEffectBasisV1Schema, MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createDeferred } from '@/testkit/async/deferred';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentIsolationProvisioningSteps } from '@/daemon/agentIsolation/provisioning';

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== 'linux')('provisions the first member home through root CHECK then APPLY when its traversal parent does not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-member-parent-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const uid = process.getuid!(), gid = process.getgid!();
    const memberParent = join(root, 'var/lib/happier');
    await mkdir(join(root, 'var/lib'), { recursive: true });
    const generated = buildAgentIsolationProvisioningSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
        binaryPath: '/opt/happier/cli/current/happier', requesterIdentity: { homeServerIdentityId: 'home',
            requester: { serverId: 'home', machineId: 'machine-a', installationId: 'installation', accountId: 'member' } } });
    const steps = generated.filter(step => [machineSetup.machineStateRootStep.id, 'member-homes', 'member-home-traversal'].includes(step.id))
        .map(step => 'path' in step ? { ...step, path: join(root, step.path) } : step);
    let traversable = false;
    const aclEffects: string[] = [], checked: unknown[] = [];
    // Only native account/ACL commands and the sudo process are boundaries.
    // The generated member plan, both interpreters and filesystem reads/writes are real.
    const runNative = async ({ executable, args }: machineSetup.MachineSetupNativeCommand): Promise<machineSetup.MachineSetupNativeCommandResult> => {
        if (executable === 'getent') return { code: 0, stdout: args.includes('group')
            ? `${args.at(-1)}:x:${gid}:\n` : `${args.at(-1)}:x:${uid}:${gid}::${root}:/usr/sbin/nologin\n`, stderr: '' };
        if (executable === 'getfacl') return { code: 0,
            stdout: `user::rwx\ngroup::---\nother::---\n${traversable ? `user:${uid}:--x\nmask::--x\n` : ''}`, stderr: '' };
        if (executable === 'setfacl') {
            expect((await lstat(memberParent)).isDirectory()).toBe(true);
            aclEffects.push(args.at(-1)!); traversable = true;
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native command ${executable}`);
    };
    const spawn: MachineElevationSpawn = launch => {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
            { stdin, stdout, runNative, readUid: () => 0 }).then(code => {
            stdout.end(); stderr.end(); return { code, signal: null };
        });
        return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
        observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }), emit: event => { checked.push(event); } };
    const apply = () => runElevatedMachineSetupIntent({ machineId: 'machine-a', operationId: 'first-member',
        basis: { kind: 'agentIsolation', machineId: 'machine-a', enabled: true,
            expectedPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' } }, steps }, dependencies);
    await expect(apply()).resolves.toMatchObject({ outcome: 'applied' });
    expect((await lstat(join(memberParent, 'members'))).isDirectory()).toBe(true);
    expect(aclEffects).toEqual([memberParent]);
    expect(checked).toContainEqual(expect.objectContaining({ type: 'machine.setup.checked' }));
    await expect(apply()).resolves.toMatchObject({ outcome: 'applied' });
    expect(aclEffects).toEqual([memberParent]);
});

const observation: MachineAdminAccessObservationV1 = { version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
    rootEquivalentGroups: [], passwordlessSudoToRoot: 'denied', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } };
const basis = { kind: 'setup' as const, machineId: 'machine-a', desiredRevision: 1 };

function nativeFixture() {
    const installed = new Set<string>();
    const mutations: string[] = [];
    const launches: Parameters<MachineElevationSpawn>[0][] = [];
    const authentication: string[] = [];
    const boundaryFailures: unknown[] = [];
    let refuse = false;
    let alterFacts = false;
    let omitResult = false;
    let passwordPrincipal: string | undefined;
    let passwordless = false;
    let requireInnerPassword = false;
    let innerDenied = false;
    let wrongInnerPrincipal = false;
    const backend: machineSetup.MachineSetupBackend = {
        async observe(step) { return { stepId: step.id, status: installed.has(step.id) ? 'satisfied' : 'drifted', facts: { installed: installed.has(step.id), generation: alterFacts ? 2 : 1 } }; },
        async apply(step) { mutations.push(step.id); installed.add(step.id); },
    };
    const spawn: MachineElevationSpawn = input => {
        launches.push(input);
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        let resolve!: (result: { code: number | null; signal: string | null }) => void;
        const settled = new Promise<{ code: number | null; signal: string | null }>(r => { resolve = r; });
        let closed = false;
        const finish = (code: number | null, signal: string | null = null) => { if (closed) return; closed = true; stdout.end(); stderr.end(); stdin.destroy(); resolve({ code, signal }); };
        // Sudo/process streams are the boundary; the root plan/interpreter is real.
        void (async () => {
            const lines = createInterface({ input: stdin, crlfDelay: Infinity });
            const iterator = lines[Symbol.asyncIterator]();
            if (input.args.includes('-S') && !passwordless) {
                // targetpw authenticates the first sudo target, not root or
                // the invoking daemon. Mirror that native password principal.
                const principal = passwordPrincipal ?? input.args[input.args.indexOf('-u') + 1];
                stderr.write(`[happier-sudo-password:${principal}]\n`);
                const answer = await iterator.next();
                authentication.push(answer.value ?? '');
                if (answer.done || refuse || answer.value !== 'one-use-password') { finish(1); return; }
            }
            if (input.args.includes('-S') && requireInnerPassword && !passwordless) {
                const separator = input.args.indexOf('--');
                const inner = input.args.slice(separator + 1);
                if (!inner.includes('-S') || innerDenied) { finish(1); return; }
                stderr.write(`[happier-sudo-root-password:${wrongInnerPrincipal ? 'root' : 'operator'}]\n`);
                const answer = await iterator.next();
                authentication.push(answer.value ?? '');
                if (answer.done || answer.value !== 'one-use-password') { finish(1); return; }
            }
            stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
            const frame = await iterator.next();
            if (frame.done) { finish(1); return; }
            const request = MachineEffectInternalRequestSchema.parse(JSON.parse(frame.value));
            if (request.mode === 'check') {
                if (!('basis' in request) || !('steps' in request)) throw new Error('Expected a setup check');
                const plan = await machineSetup.checkMachineSetupEffectPlan({ basis: request.basis, steps: request.steps, backend });
                stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
                finish(0); return;
            }
            if (!('plans' in request)) throw new Error('Expected setup plans');
            const result = await machineSetup.applyMachineSetupEffectPlans({ ...request, daemonUsername: 'daemonUsername' in request ? request.daemonUsername ?? undefined : undefined, backend,
                onProgress: event => stdout.write(JSON.stringify({ type: 'progress', ...event }) + '\n') });
            if (!omitResult) stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
            finish(0);
        })().catch(error => { boundaryFailures.push(error); finish(1); });
        return { stdin, stdout, stderr, settled, terminate: async () => finish(null, 'SIGTERM') };
    };
    const dependencies: MachineElevationDependencies = { installationId: 'install-a', installedCli: '/opt/happier/current/happier',
        readPolicy: async () => ({ version: 1, mode: 'ask', administratorUsername: 'operator' }), observe: async () => observation,
        verifyCurrent: async () => true, spawn };
    return { backend, dependencies, launches, authentication, mutations, boundaryFailures, changeFacts: () => { alterFacts = true; }, refuse: () => { refuse = true; }, loseResult: () => { omitResult = true; },
        unexpectedPrincipal: () => { passwordPrincipal = 'root'; }, noPasswordPrompt: () => { passwordless = true; }, requireAdministratorSudoPassword: () => { requireInnerPassword = true; },
        denyAdministratorSudo: () => { requireInnerPassword = true; innerDenied = true; },
        unexpectedInnerPrincipal: () => { requireInnerPassword = true; wrongInnerPrincipal = true; } };
}

async function planFor(f: ReturnType<typeof nativeFixture>, ids = ['first', 'second']) {
    const steps: MachineRecipeStepV1[] = ids.map(id => ({ id, kind: 'group', name: id, members: ['happier'] }));
    return machineSetup.checkMachineSetupEffectPlan({ basis, steps, backend: f.backend });
}

describe('one operation-scoped sudo stdin hand-off', () => {
    it('authenticates both sudo hops with the one attended answer before sending the interpreter frame', async () => {
        const f = nativeFixture();
        f.requireAdministratorSudoPassword();
        const plan = await planFor(f, ['first']);
        const prompt = vi.fn(async () => ({ password: 'one-use-password' }));
        const result = await runElevatedEffect({ machineId: 'machine-a', operationId: 'both-sudo-hops',
            effect: { kind: 'setupOperation', plans: [{ plan }] } }, { ...f.dependencies, prompt });
        expect(result).toMatchObject({ outcome: 'applied' });
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(f.authentication).toEqual(['one-use-password', 'one-use-password']);
        expect(f.mutations).toEqual(['first']);
        expect(f.boundaryFailures).toEqual([]);
    });

    it('refuses Ask as the daemon account before prompting or spawning sudo', async () => {
        const f = nativeFixture();
        const prompt = vi.fn(async () => ({ password: 'one-use-password' }));
        const result = await checkElevatedMachineSetupPlanResult({ machineId: 'machine-a', operationId: 'same-user', basis, steps: [] },
            { ...f.dependencies, observe: async () => ({ ...observation, daemonUsername: 'operator' }), prompt });
        expect(result).toMatchObject({ outcome: 'not_applied', reasonCode: 'native_check_unavailable',
            failure: { kind: 'native_check_unavailable', requiredFact: 'distinctAdministrator', remedy: expect.any(String) } });
        expect(prompt).not.toHaveBeenCalled();
        expect(f.launches).toEqual([]);
    });

    it('returns the administrator sudo prerequisite when that account has no existing root permission', async () => {
        const f = nativeFixture();
        f.denyAdministratorSudo();
        const result = await inspectMachineReachabilityNativeFirewall({ machineId: 'machine-a', requestId: 'no-admin-sudo', basis },
            { ...f.dependencies, prompt: async () => ({ password: 'one-use-password' }) });
        expect(result).toMatchObject({ ok: false, errorCode: 'native_check_unavailable', details: {
            failure: { kind: 'native_check_unavailable', requiredFact: 'administratorSudoToRoot', remedy: expect.any(String) },
            remedy: expect.any(String),
        } });
        expect(f.authentication).toEqual(['one-use-password']);
        expect(f.mutations).toEqual([]);
        expect(f.boundaryFailures).toEqual([]);
    });

    it('never submits the administrator password to an inner prompt for another principal', async () => {
        const f = nativeFixture();
        f.unexpectedInnerPrincipal();
        const result = await checkElevatedMachineSetupPlanResult({ machineId: 'machine-a', operationId: 'wrong-inner-principal', basis, steps: [] },
            { ...f.dependencies, prompt: async () => ({ password: 'one-use-password' }) });
        expect(result).toMatchObject({ outcome: 'not_applied' });
        expect(f.authentication).toEqual(['one-use-password']);
        expect(f.mutations).toEqual([]);
    });

    it.each(['none', 'ask', 'preauthorized'] as const)('prepares guest poweroff only for actual promptless daemon elevation (%s)', async mode => {
        const launches: Parameters<MachineElevationSpawn>[0][] = [];
        const spawn: MachineElevationSpawn = launch => {
            launches.push(launch);
            return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
                settled: Promise.resolve({ code: 0, signal: null }), terminate: async () => {} };
        };
        const readPolicy = async () => mode === 'ask'
            ? { version: 1 as const, mode, administratorUsername: 'operator' } : { version: 1 as const, mode };
        const denied = await prepareMachinePoweroff({ readPolicy, observe: async () => observation, spawn });
        expect(denied).toBeNull();
        const prepared = await prepareMachinePoweroff({ readPolicy,
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }), spawn });
        expect(launches).toEqual([]);
        if (mode === 'preauthorized') {
            expect(prepared).not.toBeNull();
            await prepared!();
            expect(launches).toEqual([{ executable: 'sudo', args: ['-n', '-u', 'root', '--', '/sbin/poweroff'] }]);
        } else expect(prepared).toBeNull();
    });
    it('reports successful native completion separately from an already-satisfied setup no-op', async () => {
        const fixture = nativeFixture();
        const plan = await planFor(fixture, ['first']);
        const applied: machineSetup.MachineSetupApplyResultV1[] = [];
        const input = { machineId: 'machine-a', operationId: 'operation-a',
            effect: { kind: 'setupOperation' as const, plans: [{ plan }] },
            onSetupApplied: (result: machineSetup.MachineSetupApplyResultV1) => { applied.push(result); } };
        const dependencies = { ...fixture.dependencies, prompt: async () => ({ password: 'one-use-password' }) };
        expect(await runElevatedEffect(input, dependencies)).toMatchObject({ outcome: 'applied' });
        expect(await runElevatedEffect(input, dependencies)).toMatchObject({ outcome: 'applied' });
        expect(applied.map(result => result.completedStepIds)).toEqual([['first'], []]);
        expect(fixture.mutations).toEqual(['first']);
        fixture.loseResult();
        expect(await runElevatedEffect(input, dependencies)).toMatchObject({ outcome: 'outcome_unknown' });
        expect(applied).toHaveLength(2);
        expect(fixture.boundaryFailures).toEqual([]);
    });
    it('dispatches reboot through one APPLY frame only after the host currentness boundary', async () => {
        const rebootBasis = MachineSetupEffectBasisV1Schema.safeParse({ kind: 'reboot', machineId: 'machine-a', operationId: 'reboot-a' });
        const rebootStep = MachineRecipeStepV1Schema.safeParse({ id: 'reboot', kind: 'reboot' });
        expect(rebootBasis.success).toBe(true);
        expect(rebootStep.success).toBe(true);
        if (!rebootBasis.success || !rebootStep.success) throw new Error('Reboot must use the canonical checked setup plan');
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const commands: machineSetup.MachineSetupNativeCommand[] = [];
        const frames: unknown[] = [];
        let current = true;
        const runNative = async (command: machineSetup.MachineSetupNativeCommand) => {
            commands.push(command);
            return { code: 0, stdout: '', stderr: '' };
        };
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            stdin.on('data', (chunk: Buffer) => { frames.push(JSON.parse(chunk.toString('utf8'))); });
            const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), {
                stdin, stdout, runNative, platform: 'linux', readNativeInit: async () => 'systemd\n',
            }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
            return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
        };
        const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => current,
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }) };
        const input = { machineId: 'machine-a', operationId: 'reboot-a',
            onRebootDispatch: async () => { current = false; } };
        expect(await runElevatedMachineReboot(input, dependencies)).toEqual({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(commands).toEqual([]);
        frames.length = 0;
        current = true;
        expect(await runElevatedMachineReboot({ ...input, onRebootDispatch: async () => {} }, dependencies)).toEqual({ outcome: 'dispatched' });
        expect(commands.map(command => [command.executable, command.args])).toEqual([['systemctl', ['--no-block', 'reboot']]]);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ mode: 'apply', machineId: 'machine-a', installationId: 'installation', operationId: 'reboot-a' });
    });
    it.each(['preauthorized', 'ask'] as const)('uses the same root interpreter for one %s reboot dispatch and rechecks installation before APPLY', async mode => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        expect(MachineElevatedEffectV1Schema.safeParse({ kind: 'reboot' }).success).toBe(false);
        let current = true, changeAtPreparation = true, dispatches = 0;
        const commands: machineSetup.MachineSetupNativeCommand[] = [];
        const authentication: string[] = [];
        const prompt = vi.fn(async () => ({ password: 'one-use-password' }));
        // Only OS/process/filesystem boundaries are substituted. Carrier,
        // schemas, currentness dialogue and root interpreter all remain real.
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const rootInput = mode === 'ask' ? new PassThrough() : stdin;
            const authenticationReady = mode === 'ask' ? new Promise<void>(resolve => {
                stdin.once('data', (chunk: Buffer) => {
                    authentication.push(chunk.toString('utf8')); chunk.fill(0);
                    stdin.pipe(rootInput); resolve();
                });
                queueMicrotask(() => stderr.write('[happier-sudo-password:operator]\n'));
            }) : Promise.resolve();
            const io = { stdin: rootInput, stdout, platform: 'linux' as const,
                readUid: () => { if (changeAtPreparation) current = false; return 0; },
                readNativeInit: async () => 'systemd\n',
                runNative: async (command: machineSetup.MachineSetupNativeCommand) => {
                    commands.push(command); return { code: 0, stdout: '', stderr: '' };
                } };
            const settled = authenticationReady.then(() => runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), io))
                .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
            return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); rootInput.destroy(); await settled; } };
        };
        const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
            readPolicy: async () => mode === 'ask' ? ({ version: 1, mode, administratorUsername: 'operator' }) : ({ version: 1, mode }), prompt,
            verifyCurrent: async () => current,
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }) };
        const publishing = createDeferred(), published = createDeferred();
        const input = { machineId: 'machine-a', operationId: 'reboot-a',
            onRebootDispatch: async () => { dispatches++; publishing.resolve(); await published.promise; } };
        expect(await runElevatedMachineReboot(input, dependencies)).toEqual({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(commands).toEqual([]);
        expect(dispatches).toBe(0);
        current = true; changeAtPreparation = false;
        const execution = runElevatedMachineReboot(input, dependencies);
        try {
            await publishing.promise;
            await new Promise(resolve => setImmediate(resolve));
            expect(commands).toEqual([]);
        } finally { published.resolve(); }
        expect(await execution).toEqual({ outcome: 'dispatched' });
        expect(commands.map(command => [command.executable, command.args])).toEqual([['systemctl', ['--no-block', 'reboot']]]);
        expect(dispatches).toBe(1);
        expect(await runElevatedMachineReboot({ ...input, onRebootDispatch: async () => { current = false; } }, dependencies))
            .toEqual({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(commands).toHaveLength(1);
        current = true;
        const cancelled = new AbortController();
        expect(await runElevatedMachineReboot({ ...input, signal: cancelled.signal,
            onRebootDispatch: () => cancelled.abort() }, dependencies)).toEqual({ outcome: 'not_applied', reasonCode: 'cancelled' });
        expect(commands).toHaveLength(1);
        expect(authentication).toEqual(mode === 'ask' ? Array.from({ length: 4 }, () => 'one-use-password\n') : []);
        expect(prompt).toHaveBeenCalledTimes(mode === 'ask' ? 4 : 0);
    });

    it('does not retry or report no-dispatch when the reboot command ran but its result stream was lost', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        let dispatches = 0;
        const commands: machineSetup.MachineSetupNativeCommand[] = [];
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const rootOutput = new Writable({ write(chunk, _encoding, done) {
                // The process stream boundary drops only the final receipt.
                // The root interpreter and actual dispatch decision still run.
                const line = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
                const record: unknown = JSON.parse(line);
                const checked = record && typeof record === 'object' && 'result' in record && record.result
                    && typeof record.result === 'object' && 'status' in record.result && record.result.status === 'checked';
                if (checked || !(record && typeof record === 'object' && 'type' in record && record.type === 'result')) stdout.write(chunk);
                done();
            } });
            const io = { stdin, stdout: rootOutput, platform: 'linux' as const, readNativeInit: async () => 'systemd\n',
                runNative: async (command: machineSetup.MachineSetupNativeCommand) => {
                    commands.push(command); return { code: 0, stdout: '', stderr: '' };
                } };
            const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), io)
                .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
            return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
        };
        const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }) };
        const input = { machineId: 'machine-a', operationId: 'reboot-a',
            onRebootDispatch: () => { dispatches++; } };
        expect(await runElevatedMachineReboot(input, dependencies)).toEqual({ outcome: 'outcome_unknown', failure: { kind: 'native_protocol_invalid' } });
        expect(dispatches).toBe(1);
        expect(commands.map(command => [command.executable, command.args])).toEqual([['systemctl', ['--no-block', 'reboot']]]);
    });
    it('carries the observed originating daemon through root CHECK and APPLY and emits restart need only for its changed membership', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const daemonUsername = 'machine-daemon', members = new Set(['foreign']);
        const mutations: string[] = [], events: unknown[] = [];
        const runNative = async (command: machineSetup.MachineSetupNativeCommand): Promise<machineSetup.MachineSetupNativeCommandResult> => {
            const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
            if (command.executable === 'getent') return command.args.includes('group') ? ok(`systemd-journal:x:190:${[...members].join(',')}\n`)
                : ok(`${command.args.at(-1)}:x:900:900::/var/lib/daemon:/usr/sbin/nologin\n`);
            if (command.executable === 'id') return ok(members.has(command.args.at(-1)!) ? '900 190\n' : '900\n');
            const username = command.executable === 'gpasswd' ? command.args[1]! : command.args.at(-1)!;
            if (command.executable === 'usermod') members.add(username);
            else if (command.executable === 'gpasswd') members.delete(username);
            else throw new Error(`Unexpected native mutation ${command.executable}`);
            mutations.push(username); return ok();
        };
        // Only the native sudo/process boundary is substituted. Both host ends,
        // serialized ingress, native group owner and effect interpreter are real.
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative })
                .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
            return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
        };
        const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
            observe: async () => ({ ...observation, daemonUsername, passwordlessSudoToRoot: 'allowed' }), emit: event => { events.push(event); } };
        let authorityReads = 0;
        expect(await runElevatedMachineSetupIntent({ machineId: 'machine-a', operationId: 'checked-intent', basis,
            steps: [{ id: 'journal-access', kind: 'group', name: 'systemd-journal', members: ['intent-member'], existingOnly: true }] },
        { ...dependencies, verifyCurrent: async () => { authorityReads++; return true; } })).toMatchObject({ outcome: 'applied' });
        expect(members.has('intent-member')).toBe(true);
        // Initial admission, immediately before sudo, and the actual APPLY edge.
        // Root CHECK is preparation within that same admitted operation.
        expect(authorityReads).toBe(3);
        for (const [username, state, restart] of [[daemonUsername, 'present', true], [daemonUsername, 'absent', true],
            ['happier-agent', 'present', false]] as const) {
            const steps: machineSetup.MachineRecipeStepV1[] = [{ id: 'journal-access', kind: 'group', name: 'systemd-journal', members: [username], state, existingOnly: true }];
            const plan = await checkElevatedMachineSetupPlan({ machineId: 'machine-a', operationId: 'read', basis, steps }, dependencies);
            if (!plan) throw new Error('Root CHECK must return the real reviewed group plan');
            events.length = 0;
            expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'apply',
                effect: { kind: 'setupOperation', plans: [{ plan }] } }, dependencies)).toMatchObject({ outcome: 'applied' });
            expect(events).toContainEqual(expect.objectContaining({ type: 'machine.setup.result', data: expect.objectContaining({ daemonRestartRequired: restart }) }));
            expect(members.has(username)).toBe(state === 'present');
        }
        expect(mutations).toEqual(['intent-member', daemonUsername, daemonUsername, 'happier-agent']);
        expect(members.has('foreign')).toBe(true);
    });
    it('checks protected facts in Ask mode using the password prompt without applying', async () => {
        const f = nativeFixture();
        const plan = await planFor(f);
        const prompt = vi.fn(async () => ({ password: 'one-use-password' }));
        expect(await checkElevatedMachineSetupPlan({ machineId: 'machine-a', operationId: 'review', basis, steps: plan.steps },
            { ...f.dependencies, prompt })).toEqual(plan);
        expect(prompt).toHaveBeenCalledOnce();
        expect(f.authentication).toEqual(['one-use-password']);
        expect(f.mutations).toEqual([]);
        expect(f.boundaryFailures).toEqual([]);
    });
    it('keeps protected CHECK attendance distinct from Off and unavailable preauthorization', async () => {
        const f = nativeFixture();
        const input = { machineId: 'machine-a', operationId: 'review', basis, steps: (await planFor(f)).steps };
        expect(await checkElevatedMachineSetupPlanResult(input, f.dependencies)).toMatchObject({
            outcome: 'needs_attendance', operationId: 'review', prompt: { kind: 'sudo.password', adminUsername: 'operator' },
        });
        for (const mode of ['none', 'preauthorized'] as const) {
            expect(await checkElevatedMachineSetupPlanResult(input, { ...f.dependencies,
                readPolicy: async () => ({ version: 1, mode }) })).toMatchObject({
                outcome: 'not_applied', reasonCode: mode === 'none' ? 'mode_none' : 'not_preauthorized',
            });
        }
        expect(f.launches).toEqual([]);
    });
    it('requires a fresh transient task answer for each operation and authenticates once for every step in that operation', async () => {
        const f = nativeFixture();
        const runner = createSystemTasksRunner({ kinds: {} });
        for (const operationId of ['operation-a', 'operation-b']) {
            const plan = await planFor(f, [operationId + '-1', operationId + '-2']);
            await runner.startAdmitted({ taskId: operationId, kind: 'machine.setup.apply.v1', params: {} }, { run: async ctx =>
                await runElevatedEffect({ machineId: 'machine-a', operationId, effect: { kind: 'setupOperation', plans: [{ plan }] } },
                    { ...f.dependencies, prompt: ctx.prompt, emit: ctx.emit }) });
            // The real runner owns the unanswered prompt, not a test-injected password service.
            await new Promise(resolve => setImmediate(resolve));
            expect((await runner.poll({ taskId: operationId, cursor: 0 })).pendingPrompt?.kind).toBe('sudo.password');
            await runner.respond({ taskId: operationId, expectedPromptKind: 'sudo.password', answer: { password: 'one-use-password' } });
            const result = await runner.wait({ taskId: operationId });
            expect(f.boundaryFailures).toEqual([]);
            expect(f.mutations).toContain(operationId + '-2');
            expect(result).toMatchObject({ ok: true, data: { outcome: 'applied' } });
            const retained = await runner.poll({ taskId: operationId, cursor: 0 });
            expect(retained.events.some(e => e.stepId === operationId + '-2')).toBe(true);
            expect(JSON.stringify(retained)).not.toContain('one-use-password');
            await expect(runner.respond({ taskId: operationId, answer: { password: 'one-use-password' } })).rejects.toThrow();
        }
        expect(f.launches).toHaveLength(2);
        expect(f.authentication).toEqual(['one-use-password', 'one-use-password']);
        expect(f.mutations).toHaveLength(4);
        expect(JSON.stringify(f.launches)).not.toContain('one-use-password');
        expect(f.launches.every(l => l.args.includes('-k') && l.args.includes('-S') && l.args.includes('root'))).toBe(true);
    });

    it('accepts changed native facts, refuses wrong or absent attendance, and preserves lost confirmation as unknown', async () => {
        const changed = nativeFixture(); const plan = await planFor(changed); changed.changeFacts();
        const effect = { kind: 'setupOperation' as const, plans: [{ plan }] };
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'changed', effect }, { ...changed.dependencies, prompt: async () => ({ password: 'one-use-password' }) }))
            .toMatchObject({ outcome: 'applied' });
        expect(changed.mutations).toEqual(['first', 'second']);
        const wrong = nativeFixture(); const wrongPlan = await planFor(wrong);
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'wrong', effect: { ...effect, plans: [{ plan: wrongPlan }] } },
            { ...wrong.dependencies, prompt: async () => ({ password: 'wrong' }) })).toMatchObject({ outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                failure: { requiredFact: 'administratorSudoToRoot' } });
        expect(wrong.mutations).toEqual([]);
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'absent', effect }, changed.dependencies)).toMatchObject({ outcome: 'needs_attendance' });
        const lost = nativeFixture(); const lostPlan = await planFor(lost); lost.loseResult();
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'lost', effect: { ...effect, plans: [{ plan: lostPlan }] } },
            { ...lost.dependencies, prompt: async () => ({ password: 'one-use-password' }) })).toMatchObject({ outcome: 'outcome_unknown' });
    });

    it('constrains unattended execution by both desired mode and a fresh root-specific observation', async () => {
        const f = nativeFixture(); const plan = await planFor(f);
        const input = { machineId: 'machine-a', operationId: 'unattended', effect: { kind: 'setupOperation' as const, plans: [{ plan }] } };
        expect(await runElevatedEffect(input, { ...f.dependencies, readPolicy: async () => ({ version: 1, mode: 'none' }) }))
            .toEqual({ outcome: 'not_applied', reasonCode: 'mode_none' });
        expect(await runElevatedEffect(input, { ...f.dependencies, readPolicy: async () => ({ version: 1, mode: 'preauthorized' }) }))
            .toMatchObject({ outcome: 'not_applied', reasonCode: 'not_preauthorized' });
        expect(f.launches).toEqual([]);
        expect(await runElevatedEffect(input, { ...f.dependencies, readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }) })).toMatchObject({ outcome: 'applied' });
        expect(f.authentication).toEqual([]);
        expect(f.launches).toHaveLength(1);
        expect(f.launches[0]?.args).toContain('-n');
    });

    it('settles cancelled attendance and a retired installation before launching sudo', async () => {
        const f = nativeFixture(); const plan = await planFor(f);
        const effect = { kind: 'setupOperation' as const, plans: [{ plan }] };
        let current = true;
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'retired', effect }, { ...f.dependencies,
            verifyCurrent: async () => current, prompt: async () => { current = false; return { password: 'one-use-password' }; } }))
            .toMatchObject({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(f.launches).toEqual([]);
        const runner = createSystemTasksRunner({ kinds: {} });
        await runner.startAdmitted({ taskId: 'cancelled', kind: 'machine.setup.apply.v1', params: {} }, { run: async ctx =>
            await runElevatedEffect({ machineId: 'machine-a', operationId: 'cancelled', effect, signal: ctx.signal },
                { ...f.dependencies, prompt: ctx.prompt, emit: ctx.emit }) });
        await new Promise(resolve => setImmediate(resolve));
        expect((await runner.poll({ taskId: 'cancelled', cursor: 0 })).pendingPrompt?.kind).toBe('sudo.password');
        await runner.cancel({ taskId: 'cancelled' });
        const result = await runner.wait({ taskId: 'cancelled' });
        expect(result).toMatchObject({ ok: true, data: { outcome: 'not_applied', reasonCode: 'cancelled' } });
        expect((await runner.poll({ taskId: 'cancelled', cursor: 0 })).pendingPrompt).toBeNull();
        expect(f.launches).toEqual([]);
    });

    it.each(['check', 'apply'] as const)('allows an attended Ask %s when sudo already permits root without consuming the password', async kind => {
        const f = nativeFixture(); f.noPasswordPrompt();
        const plan = await planFor(f);
        const dependencies = { ...f.dependencies, prompt: async () => ({ password: 'one-use-password' }) };
        const input = { machineId: 'machine-a', operationId: 'passwordless-ask' };
        const result = kind === 'check'
            ? await checkElevatedMachineSetupPlanResult({ ...input, basis, steps: plan.steps }, dependencies)
            : await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan }] } }, dependencies);
        expect(result).toMatchObject({ outcome: kind === 'check' ? 'checked' : 'applied' });
        expect(f.authentication).toEqual([]);
        expect(f.mutations).toEqual(kind === 'check' ? [] : ['first', 'second']);
        expect(f.boundaryFailures).toEqual([]);
        expect(JSON.stringify(f.launches)).not.toContain('one-use-password');
    });

    it('never gives the password or plan to an unexpected password principal', async () => {
        const f = nativeFixture(); f.unexpectedPrincipal();
        const plan = await planFor(f);
        expect(await runElevatedEffect({ machineId: 'machine-a', operationId: 'unexpectedPrincipal',
            effect: { kind: 'setupOperation', plans: [{ plan }] } },
            { ...f.dependencies, prompt: async () => ({ password: 'one-use-password' }) }))
            .toMatchObject({ outcome: 'not_applied', reasonCode: 'denied' });
        expect(f.authentication.filter(Boolean)).toEqual([]);
        expect(f.mutations).toEqual([]);
    });

    it('refuses unavailable currentness after attendance without starting an effect', async () => {
        const f = nativeFixture(); const plan = await planFor(f);
        let answered = false;
        await expect(runElevatedEffect({ machineId: 'machine-a', operationId: 'currentness-unavailable',
            effect: { kind: 'setupOperation', plans: [{ plan }] } },
            { ...f.dependencies, verifyCurrent: async () => {
                if (answered) throw new Error('private-currentness-diagnostic');
                return true;
            }, prompt: async () => { answered = true; return { password: 'one-use-password' }; } }))
            .resolves.toMatchObject({ outcome: 'not_applied', reasonCode: 'denied' });
        expect(f.launches).toEqual([]);
        expect(f.mutations).toEqual([]);
    });

    it('refuses a connector grant bound to another parent operation before launching sudo', async () => {
        const f = nativeFixture();
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'machine-a', installationId: 'install-a',
            provider: { pluginId: 'example.network', localId: 'connector' }, connectorId: 'connector' };
        const { machineSecretGrantSubjectKey } = await import('@happier-dev/deployment-protocol');
        const plan = machineSetup.createMachineSetupEffectPlan({ basis, steps: [{ id: 'token', kind: 'file',
            path: '/etc/example/connector.token', mode: 0o600, owner: 'root', group: 'root',
            content: { kind: 'secretGrant', grantRef: machineSecretGrantSubjectKey(subject) } }],
            nativeFacts: [{ stepId: 'token', status: 'drifted', facts: { present: false } }] });
        const result = await runElevatedEffect({ machineId: 'machine-a', operationId: 'current-operation',
            effect: { kind: 'setupOperation', plans: [{ plan }] } }, { ...f.dependencies,
            prompt: async () => ({ password: 'one-use-password' }),
            connectorSecretGrant: { credentials: { token: 'transport-token' }, context: { operationAcceptance: { operationId: 'other-operation' } },
                signal: new AbortController().signal, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
                hostMachineId: 'machine-a', hostInstallationId: 'install-a', subject, async assertCurrent() {} },
        });
        expect(result).toMatchObject({ outcome: 'not_applied', reasonCode: 'denied' });
        expect(f.launches).toEqual([]);
        expect(f.mutations).toEqual([]);
    });

    it('settles child cancellation while its exact signed header exchange is still pending', async () => {
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'machine-a', installationId: 'install-a',
            provider: { pluginId: 'example.network', localId: 'connector' }, connectorId: 'connector' };
        const { machineSecretGrantSubjectKey } = await import('@happier-dev/deployment-protocol');
        const plan = machineSetup.createMachineSetupEffectPlan({ basis, steps: [{ id: 'token', kind: 'file',
            path: '/etc/example/connector.token', mode: 0o600, owner: 'root', group: 'root',
            content: { kind: 'secretGrant', grantRef: machineSecretGrantSubjectKey(subject) } }],
            nativeFacts: [{ stepId: 'token', status: 'drifted', facts: { present: false } }] });
        const controller = new AbortController();
        let hold = false, held = false, finished = false;
        let release!: () => void;
        const parentCheck = new Promise<void>(resolve => { release = resolve; });
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
        const channel = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => channel.close());
        // Header construction keeps the real Account encryption observation,
        // not another root-admission POST. Hold its actual HTTP boundary after
        // the child asks for signed headers; projection and signing stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (hold && url === 'https://home.test/v1/account/encryption/currentness') {
                held = true;
                await parentCheck;
            }
            return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine-a', installationId: 'install-a',
            actionId: 'machines.setup.apply', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-a' },
        } });
        const projected = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'home',
            bootstrap: { credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.test',
                isCurrent: async () => true, attribution: { serverId: 'home', accountId: 'owner',
                    machineId: 'machine-a', installationId: 'install-a' } } });
        if (!projected) throw new Error('Expected real requester Account custody');
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
            target: authorization.binding.target, installationId: 'install-a', privateKey: keys.secretKey });
        if (!carrier) throw new Error('Expected real requester HTTP custody');
        const body = { operation: 'read' as const, serverId: 'home', hostMachineId: 'machine-a', hostInstallationId: 'install-a', subject };
        const proof = signMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine-a',
            installationId: 'install-a', deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
            privateKey: encodeBase64(keys.secretKey, 'base64url') });
        // The child process is an OS boundary. It requests actual signed read
        // headers after consuming its session, then loses its result on SIGTERM.
        const spawn: MachineElevationSpawn = () => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            let close!: (value: { code: number | null; signal: string | null }) => void;
            const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { close = resolve; });
            const lines = createInterface({ input: stdin, crlfDelay: Infinity });
            lines.on('line', line => {
                const frame: unknown = JSON.parse(line);
                if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'connector.secretGrant.session') {
                    hold = true;
                    stdout.write(JSON.stringify({ type: 'connector.secretGrant.control', operation: 'headers', body: { ...body, proof } }) + '\n');
                }
            });
            stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
            return { stdin, stdout, stderr, settled, async terminate() {
                lines.close(); stdin.destroy(); stdout.end(); stderr.end(); close({ code: null, signal: 'SIGTERM' }); await settled;
            } };
        };
        const operation = runElevatedEffect({ machineId: 'machine-a', operationId: 'operation', signal: controller.signal,
            effect: { kind: 'setupOperation', plans: [{ plan }] } }, {
            installationId: 'install-a', installedCli: '/opt/happier/current/happier', spawn,
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
            observe: async () => ({ ...observation, passwordlessSudoToRoot: 'allowed' }), verifyCurrent: async () => true,
            connectorSecretGrant: { credentials: { token }, context: { operationAcceptance: { operationId: 'operation' },
                externalActionExecutionAuthorization: carrier },
                signal: controller.signal, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
                hostMachineId: 'machine-a', hostInstallationId: 'install-a', subject,
                async assertCurrent() {},
            },
        }).then(result => { finished = true; return result; });
        try {
            await vi.waitFor(() => { expect({ held, finished }).toEqual({ held: true, finished: false }); });
            controller.abort();
            await vi.waitFor(() => { expect(finished).toBe(true); });
            expect(await operation).toMatchObject({ outcome: 'outcome_unknown' });
        } finally { release(); controller.abort(); await operation; }
    });
});
