import { join } from 'node:path';
import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
    type MachineSetupEffectPlanV1, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import type { MachineAdminAccessObservationV1, MachineRecipeStepV1 } from '@happier-dev/protocol';
import { MachineElevatedResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { runElevatedMachineFirewallPlans, type MachineElevationDependencies, type MachineElevationSpawn } from '../adminAccess/runElevatedEffect';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema, MachineEffectInternalRequestSchema } from './effectInternalProtocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { MachineFirewallTransitionIntentV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { inspectMachineReachabilityNativeFirewall } from '../reachability/inspectMachineReachabilityNativeFirewall';
import { settleMachineCaddyFirewallForHost, settleMachinePrivateWorkloadFirewallForHost } from '../reachability/machineReachabilityHost';
import { nativeCaddyImage } from '@happier-dev/cli-common/machineSetup';
import { observeOwnDaemonReachability } from '../reachability/observeOwnDaemonReachability';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

// Genuine OS boundary only. All file bytes, native backend, schema/digest,
// elevation framing, root entry and undo execution remain real.
const os = vi.hoisted((): { root: string; owners: Map<number, { uid: number; gid: number }>;
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> } => ({ root: '', owners: new Map(), interfaces: {} }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), networkInterfaces: () => os.interfaces }));
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    const path = (value: import('node:fs').PathLike) => typeof value === 'string' && value.startsWith('/')
        && !value.startsWith(os.root + '/') && value !== os.root ? join(os.root, value) : value;
    return { ...fs,
        async lstat(value: import('node:fs').PathLike) {
            const stat = await fs.lstat(path(value)), owner = os.owners.get(stat.ino) ?? { uid: 0, gid: 0 };
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, owner) as typeof stat;
        },
        readFile: ((value: import('node:fs').PathLike, ...args: unknown[]) => Reflect.apply(fs.readFile, fs, [path(value), ...args])),
        readlink: ((value: import('node:fs').PathLike, ...args: unknown[]) => Reflect.apply(fs.readlink, fs, [path(value), ...args])),
        writeFile: ((value: import('node:fs').PathLike, ...args: unknown[]) => Reflect.apply(fs.writeFile, fs, [path(value), ...args])),
        chmod: (value: import('node:fs').PathLike, mode: number) => fs.chmod(path(value), mode),
        async chown(value: import('node:fs').PathLike, uid: number, gid: number) { os.owners.set((await fs.lstat(path(value))).ino, { uid, gid }); },
        mkdir: ((value: import('node:fs').PathLike, ...args: unknown[]) => Reflect.apply(fs.mkdir, fs, [path(value), ...args])),
        async mkdtemp(value: string) { return (await fs.mkdtemp(String(path(value)))).slice(os.root.length); },
        rename: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => fs.rename(path(from), path(to)),
        rm: ((value: import('node:fs').PathLike, ...args: unknown[]) => Reflect.apply(fs.rm, fs, [path(value), ...args])),
        rmdir: (value: import('node:fs').PathLike) => fs.rmdir(path(value)),
        unlink: (value: import('node:fs').PathLike) => fs.unlink(path(value)),
    };
});
afterEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    if (os.root) await fs.rm(os.root, { recursive: true, force: true });
    os.root = ''; os.owners.clear(); os.interfaces = {}; vi.restoreAllMocks();
});
const rulesPath = '/etc/happier/firewall/rules.nft', unitPath = '/etc/systemd/system/happier-firewall.service';

// The retained full-value serialization is pinned by the captured pre-cut
// vector in cli-common/machineSetup/interpreter.test.ts. Use the same canonical
// JSON owner to project real native plans, not a second production writer.
function retainedPlan(plan: MachineSetupEffectPlanV1): MachineSetupEffectPlanV1 {
    const { planDigest: _digest, ...contents } = plan;
    return { ...plan, planDigest: createHash('sha256').update(createCanonicalJsonSigningInput(contents)).digest('hex') };
}

async function fixture(mode: 'ask' | 'preauthorized', delayProgress = false) {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    os.root = await fs.mkdtemp(join(tmpdir(), 'happier-firewall-p10-'));
    const disk = (path: string) => path.startsWith(os.root + '/') ? path : join(os.root, path);
    for (const path of ['/etc/happier/firewall', '/etc/systemd/system', '/usr/sbin', '/proc/1']) await fs.mkdir(disk(path), { recursive: true, mode: 0o755 });
    await fs.writeFile(disk('/proc/1/comm'), 'systemd\n');
    await fs.writeFile(disk('/usr/sbin/nft'), 'system executable OS fixture', { mode: 0o755 });
    let table: string | undefined, enabled = false, active = false;
    let routes4: unknown = [{ dst: 'default', dev: 'ens18', gateway: '10.10.0.1' }], routes6: unknown = [];
    let ssh4 = '', ssh6 = '';
    let nativePolicy: unknown;
    const events: ('prompt' | 'native')[] = [];
    os.interfaces = {};
    const calls: MachineSetupNativeCommand[] = [];
    let docker: ((command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) | undefined;
    const runNative = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
        calls.push(command); events.push('native'); const args = command.args;
        if (command.executable === 'docker' && docker) return docker(command);
        if (command.executable === 'ip') {
            if (args.includes('route')) return { code: 0, stdout: JSON.stringify(args.includes('-4') ? routes4 : routes6), stderr: '' };
        }
        if (command.executable === 'ss') return { code: 0, stdout: args.includes('-4') ? ssh4 : ssh6, stderr: '' };
        if (command.executable === 'getent') {
            const account = args.at(-1)!, uid = account === 'root' ? 0 : 1001;
            return { code: 0, stdout: args.includes('passwd') ? `${account}:x:${uid}:${uid}::/home/test:/bin/sh\n` : `${account}:x:${uid}:\n`, stderr: '' };
        }
        if (command.executable === '/usr/sbin/nft') {
            if (args.includes('--version')) return { code: 0, stdout: 'nftables v1.0.9\n', stderr: '' };
            if (args.includes('-c')) return { code: 0, stdout: '', stderr: '' };
            if (args.includes('tables')) return { code: 0, stdout: JSON.stringify({ nftables: table ? [{ table: { family: 'inet', name: 'happier' } }] : [] }), stderr: '' };
            if (args.includes('-j') && args.includes('table')) return {
                code: table && nativePolicy !== undefined ? 0 : 1,
                stdout: nativePolicy === undefined ? '' : JSON.stringify(nativePolicy), stderr: '',
            };
            if (args.includes('list')) return { code: table ? 0 : 1, stdout: table ?? '', stderr: '' };
            if (args.includes('-f')) { table = await fs.readFile(disk(args[args.indexOf('-f') + 1]!), 'utf8'); return { code: 0, stdout: '', stderr: '' }; }
            if (args[0] === 'delete') { table = undefined; return { code: 0, stdout: '', stderr: '' }; }
        }
        if (command.executable === 'systemctl') {
            if (args[0] === 'show') return { code: 0, stdout: `LoadState=${await fs.lstat(disk(unitPath)).then(() => true, () => false) ? 'loaded' : 'not-found'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${active ? 'active' : 'inactive'}\n`, stderr: '' };
            if (args[0] === 'enable') enabled = true;
            else if (args[0] === 'disable') enabled = false;
            else if (args[0] === 'start') active = true;
            else if (args[0] === 'stop') active = false;
            else if (args[0] !== 'daemon-reload') throw new Error('Unexpected native service boundary');
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error('Unexpected native boundary');
    };
    const backend = createMachineSetupNativeBackend({ run: runNative, daemonUsername: 'happier', platform: 'linux' });
    const launches: unknown[] = [];
    const frames: unknown[] = [], authentication: string[] = [], boundaryFailures: unknown[] = [];
    let lateProgressAfterCancel = false;
    const spawn: MachineElevationSpawn = invocation => {
        const invocationMode = invocation.args.includes('-S') ? 'ask' : 'preauthorized';
        launches.push(invocation);
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        const rootInput = invocationMode === 'ask' ? new PassThrough() : stdin;
        const signal = new AbortController();
        const heldProgress: Buffer[] = [];
        // Delay genuine already-produced records only at the stdout transport
        // boundary, then deliver them before the authoritative terminal.
        const rootOutput = delayProgress ? new Writable({ write(chunk: Buffer, _encoding, done) {
            const record = MachineEffectInternalRecordSchema.parse(JSON.parse(chunk.toString('utf8')));
            if (record.type === 'progress' && record.phase === 'verify') { heldProgress.push(Buffer.from(chunk)); done(); return; }
            if (record.type === 'result' && record.result.status !== 'checked') {
                lateProgressAfterCancel = signal.signal.aborted && heldProgress.length > 0;
                for (const progress of heldProgress.splice(0)) stdout.write(progress);
            }
            stdout.write(chunk); done();
        } }) : stdout;
        const authenticated = invocationMode === 'ask' ? new Promise<void>(resolve => {
            stdin.once('data', (chunk: Buffer) => {
                authentication.push(chunk.toString('utf8')); chunk.fill(0);
                stdin.pipe(rootInput); resolve();
            });
            queueMicrotask(() => stderr.write('[happier-sudo-password:operator]\n'));
        }) : Promise.resolve();
        rootInput.on('data', (chunk: Buffer) => { frames.push(JSON.parse(chunk.toString('utf8'))); });
        const running = authenticated.then(() => runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
            stdin: rootInput, stdout: rootOutput, signal: signal.signal, runNative, readUid: () => 0, platform: 'linux',
        })).catch(error => { boundaryFailures.push(error); return 1; });
        const settled = running.then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
        return { stdin, stdout, stderr, settled, async terminate() { signal.abort(); stdin.end(); rootInput.end(); await settled; } };
    };
    const observation: MachineAdminAccessObservationV1 = { version: 1, observedAt: 1, daemonUid: 1001,
        daemonUsername: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
        managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } };
    const verifyCurrent = vi.fn(async () => true), prompt = vi.fn(async () => {
        events.push('prompt'); return { password: 'one-use-password' };
    });
    const deps = { installationId: 'installation', installedCli: '/opt/happier/current/happier',
        readPolicy: async () => mode === 'ask' ? ({ version: 1 as const, mode, administratorUsername: 'operator' }) : ({ version: 1 as const, mode }),
        observe: async () => observation, verifyCurrent, prompt, spawn } satisfies MachineElevationDependencies;
    return { fs, disk, backend, calls, events, launches, frames, authentication, boundaryFailures, verifyCurrent, prompt, deps, readTable: () => table,
        setNativePolicy(value: unknown) { nativePolicy = value; },
        setDocker(run: NonNullable<typeof docker>) { docker = run; },
        async setFirewallFacts(input: Readonly<{ interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>; routes4?: unknown; routes6?: unknown;
            ssh4?: string; ssh6?: string; sshExecutableOwnedBy?: number }>) {
            os.interfaces = input.interfaces;
            if ('routes4' in input) routes4 = input.routes4;
            if ('routes6' in input) routes6 = input.routes6;
            ssh4 = input.ssh4 ?? ''; ssh6 = input.ssh6 ?? '';
            if (ssh4 || ssh6) {
                await fs.mkdir(disk('/proc/412'), { recursive: true, mode: 0o755 });
                await fs.writeFile(disk('/usr/sbin/sshd'), 'system sshd OS fixture', { mode: 0o755 });
                os.owners.set((await fs.lstat(disk('/usr/sbin/sshd'))).ino, { uid: input.sshExecutableOwnedBy ?? 0, gid: input.sshExecutableOwnedBy ?? 0 });
                await fs.symlink('/usr/sbin/sshd', disk('/proc/412/exe'));
            }
        },
        lateProgressAfterCancel: () => lateProgressAfterCancel };
}

describe('firewall through the same P10 installed root invocation', () => {
    it('retains a workload through the Domain host and its real root CHECK/APPLY reconciliation', async () => {
        const f = await fixture('preauthorized');
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
            tun42: [{ address: '100.96.0.4', netmask: '255.255.0.0', family: 'IPv4',
                mac: '00:00:00:00:00:02', internal: false, cidr: '100.96.0.4/16' }],
        } });
        const metadata = { reachabilityPosture: { revision: 0,
            management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } } };
        const bindings = { environmentId: 'database-environment', bindings: [{
            exposure: { requirementId: 'postgres', exposure: 'privateNetwork', providerId: 'selected-provider',
                networkIdentity: 'selected-network', hostAddress: '100.96.0.4', hostPort: 25432, containerPort: 5432, protocol: 'tcp' },
            interfaceName: 'tun42', sourceRanges: ['100.96.0.0/16'],
        }] };
        const settle = (publication: boolean) => machineNativeEffectAdmission.run({
            operation: { operationId: publication ? 'publish-database' : 'domain-reconcile', kind: 'deployments.domains.add' },
            keys: [{ kind: 'machineSetup' }],
        }, native => settleMachineCaddyFirewallForHost({
            machineId: 'machine', installationId: 'installation', operationId: native.operation.operationId, native,
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
            port: { read: async () => ({ status: 'ready', metadata, metadataVersion: 1 }),
                compareAndSwap: async () => { throw new Error('Unchanged Domain posture cannot write Machine metadata'); } },
            elevation: f.deps,
            readDaemonProof: () => observeOwnDaemonReachability({ client: {
                isMachineControlRegistrationReady: () => true,
                callConnectedClientRpc: async () => ({ ok: true, result: {} }),
            } }),
            caddy: { publicBindings: [{ requirementId: 'https', exposure: 'public', hostAddress: '0.0.0.0',
                hostPort: 443, containerPort: 443, protocol: 'tcp' }] },
            ...(publication ? { privateWorkloadBindings: MachineFirewallTransitionIntentV1Schema.parse({
                v: 1, kind: 'preserveSsh', caddy: {}, publicSsh: { kind: 'closed' }, privateWorkloadBindings: bindings,
            }).privateWorkloadBindings } : {}),
        }));
        await settle(true);
        await settle(false);
        expect(f.boundaryFailures).toEqual([]);
        expect(f.readTable()).toContain('iifname "tun42" ip saddr 100.96.0.0/16 meta l4proto tcp ct original ip daddr 100.96.0.4 ct original proto-dst 25432 accept');
        expect(f.readTable()).toContain('tcp dport 443 accept');
        expect(f.readTable()).toContain('ct state new ct direction original ct status dnat drop');
        expect(metadata.reachabilityPosture.management.publicSsh).toEqual({ kind: 'closed' });
    });

    it.each(['ask', 'preauthorized'] as const)('retains Caddy and another workload when withdrawing a publication through the %s protected CHECK', async mode => {
        const f = await fixture(mode);
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
            tun42: [{ address: '100.96.0.4', netmask: '255.255.0.0', family: 'IPv4',
                mac: '00:00:00:00:00:02', internal: false, cidr: '100.96.0.4/16' }],
        } });
        const container = { Id: 'owned-caddy', Name: '/happier-caddy',
            Config: { Image: nativeCaddyImage, Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'],
                Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' } },
            HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [], Binds: null,
                PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] } },
            State: { Running: false }, NetworkSettings: { Networks: {}, Ports: null } };
        f.setDocker(async command => {
            // Genuine OS boundary: Docker is readable only inside the admitted root invocation.
            if (!f.launches.length) return { code: 1, stdout: '', stderr: 'daemon Docker permission denied' };
            if (command.args[0] === 'container' && command.args[1] === 'ls')
                return { code: 0, stdout: JSON.stringify(container.Id), stderr: '' };
            if (command.args[0] === 'container' && command.args[1] === 'inspect')
                return { code: 0, stdout: JSON.stringify([container]), stderr: '' };
            throw new Error('Protected firewall inventory must not mutate Docker');
        });
        const metadata = { reachabilityPosture: { revision: 0,
            management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } } };
        const publication = (environmentId: string, hostPort: number) => MachineFirewallTransitionIntentV1Schema.parse({
            v: 1, kind: 'preserveSsh', caddy: {}, publicSsh: { kind: 'closed' }, privateWorkloadBindings: { environmentId, bindings: [{
                exposure: { requirementId: 'database', exposure: 'privateNetwork', providerId: 'selected-provider',
                    networkIdentity: 'selected-network', hostAddress: '100.96.0.4', hostPort, containerPort: 5432, protocol: 'tcp' },
                interfaceName: 'tun42', sourceRanges: ['100.96.0.0/16'],
            }] },
        }).privateWorkloadBindings!;
        const settle = (privateWorkloadBindings: ReturnType<typeof publication>) => machineNativeEffectAdmission.run({
            operation: { operationId: `workload-${privateWorkloadBindings.environmentId}-${privateWorkloadBindings.bindings.length}`, kind: 'deployments.deploy' },
            keys: [{ kind: 'machineSetup' }] }, native => settleMachinePrivateWorkloadFirewallForHost({
            machineId: 'machine', installationId: 'installation', operationId: native.operation.operationId, native,
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
            port: { read: async () => ({ status: 'ready', metadata, metadataVersion: 1 }),
                compareAndSwap: async () => { throw new Error('Unchanged workload posture cannot write metadata'); } },
            elevation: f.deps, privateNetworks: [], privateWorkloadBindings,
            readDaemonProof: () => observeOwnDaemonReachability({ client: {
                isMachineControlRegistrationReady: () => true, callConnectedClientRpc: async () => ({ ok: true, result: {} }),
            } }),
        }));
        await settle(publication('retained-environment', 25432));
        await settle(publication('withdrawn-environment', 25433));
        expect(f.readTable()).toContain('tcp dport 25432 accept');
        expect(f.readTable()).toContain('tcp dport 25433 accept');
        await settle({ environmentId: 'withdrawn-environment', bindings: [] });
        expect(f.boundaryFailures).toEqual([]);
        expect(f.launches).toHaveLength(3);
        expect(f.prompt).toHaveBeenCalledTimes(mode === 'ask' ? 3 : 0);
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check', 'apply', 'check', 'apply', 'check', 'apply']);
        expect(f.readTable()).toContain('tcp dport 80 accept');
        expect(f.readTable()).toContain('tcp dport 25432 accept');
        expect(f.readTable()).toContain('ct original proto-dst 25432 accept');
        expect(f.readTable()).not.toContain('25433');
        expect(metadata.reachabilityPosture.management.publicSsh).toEqual({ kind: 'closed' });
    });

    it('keeps an unavailable private-workload Caddy fact as a typed protected CHECK refusal without APPLY', async () => {
        const f = await fixture('ask');
        f.setDocker(async () => ({ code: null, errorCode: 'ENOENT', stdout: '', stderr: '' }));
        const metadata = { reachabilityPosture: { revision: 0,
            management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } } };
        const pending = machineNativeEffectAdmission.run({ operation: { operationId: 'unavailable-private-workload', kind: 'deployments.deploy' },
            keys: [{ kind: 'machineSetup' }] }, native => settleMachinePrivateWorkloadFirewallForHost({
            machineId: 'machine', installationId: 'installation', operationId: native.operation.operationId, native,
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
            port: { read: async () => ({ status: 'ready', metadata, metadataVersion: 1 }),
                compareAndSwap: async () => { throw new Error('Unavailable inventory cannot write metadata'); } },
            elevation: f.deps, privateNetworks: [], privateWorkloadBindings: { environmentId: 'environment', bindings: [] },
            readDaemonProof: async () => { throw new Error('No APPLY or daemon ACK before native inventory'); },
        }));
        await expect(pending).rejects.toMatchObject({ code: 'required_fact_unavailable',
            details: { requiredFact: 'caddyContainer', failure: { kind: 'native_check_unavailable',
                reason: 'required_fact_unavailable', requiredFact: 'caddyContainer' }, remedy: expect.any(String) },
            cause: { effectAttempted: false } });
        expect(f.boundaryFailures).toEqual([]);
        expect(f.launches).toHaveLength(1);
        expect(f.frames.map(frame => MachineEffectInternalRequestSchema.parse(frame).mode)).toEqual(['check']);
        expect(f.readTable()).toBeUndefined();
    });

    it.each(['ask', 'preauthorized'] as const)('inspects native SSH endpoints through the %s root CHECK without APPLY', async mode => {
        const f = await fixture(mode);
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
        }, ssh4: 'LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n' });
        expect(await inspectMachineReachabilityNativeFirewall({ machineId: 'machine', requestId: 'inspect',
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 } }, f.deps)).toEqual({ ok: true, facts: {
            status: 'available', ownedTable: 'absent', externalInterfaces: ['ens18'], privateInterfaces: [],
            retainedSshEndpoints: [{ interfaceName: 'ens18', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] }],
        } });
        expect(f.launches).toEqual([expect.objectContaining({ executable: 'sudo', args: expect.arrayContaining([mode === 'ask' ? '-S' : '-n', '-u', 'root']) })]);
        expect(f.frames).toEqual([expect.objectContaining({ mode: 'check' })]);
        expect(f.prompt).toHaveBeenCalledTimes(mode === 'ask' ? 1 : 0);
        expect(f.authentication).toEqual(mode === 'ask' ? ['one-use-password\n'] : []);
        expect(f.readTable()).toBeUndefined();
        expect(f.calls.filter(call => call.executable === 'systemctl' && call.args[0] !== 'show'
            || call.args.includes('-f') && !call.args.includes('-c') || call.args[0] === 'delete')).toEqual([]);
    });

    it('retains password attendance recovery when no interactive task is available', async () => {
        const f = await fixture('ask');
        expect(await inspectMachineReachabilityNativeFirewall({ machineId: 'machine', requestId: 'inspect',
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 } }, { ...f.deps, prompt: undefined }))
            .toMatchObject({ ok: false, errorCode: 'machine_admin_access_required', details: { elevation: {
                outcome: 'needs_attendance', operationId: 'inspect', prompt: { kind: 'sudo.password', adminUsername: 'operator' },
            } } });
        expect(f.launches).toEqual([]);
    });

    it.each([
        { mode: 'preauthorized', kind: 'retainSsh' },
        { mode: 'ask', kind: 'retainSsh' },
        { mode: 'preauthorized', kind: 'preserveSsh' },
    ] as const)('materializes $kind from actual protected facts inside one $mode CHECK→APPLY', async ({ mode, kind }) => {
        const f = await fixture(mode);
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
        }, ssh4: 'LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n'
            + 'LISTEN 0 128 10.10.0.4:2222 0.0.0.0:* users:(("sshd",pid=412,fd=4))\n' });
        const firewallIntent = MachineFirewallTransitionIntentV1Schema.parse({
            v: 1, kind,
            caddy: { publicBindings: [{ requirementId: 'https', hostAddress: '0.0.0.0', hostPort: 443,
                protocol: 'tcp', containerPort: 443, exposure: 'public' }] },
            publicSsh: kind === 'preserveSsh' ? { kind: 'closed' }
                : { kind: 'open', port: 22, sourceCidrs: ['198.51.100.0/24'] },
        });
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const stages: number[] = [], stageDigests: string[] = [];
        const result = await runElevatedMachineFirewallPlans({ machineId: 'machine', operationId: 'bounded-retain-all',
            basis, firewallIntent,
            async onStage(stage) {
                stages.push(stage.planIndex); stageDigests.push(stage.planDigest);
                expect(await stage.verifyNative()).toBe(true);
                expect(f.readTable()).toContain('tcp dport 2205 accept');
                expect(f.readTable()).toContain('ip daddr 10.10.0.4 ip saddr 0.0.0.0/0 tcp dport 2222 accept');
                if (stage.planIndex === 0) {
                    expect(stage.recovery).toEqual({ rules: { kind: 'absent' }, unit: { kind: 'absent' },
                        table: null, boot: { present: false, enabled: false, running: false } });
                    expect(f.readTable()).not.toContain('tcp dport 22 accept');
                    return 'continue';
                }
                expect(f.readTable()!.includes('ip saddr 198.51.100.0/24 tcp dport 22 accept')).toBe(kind === 'retainSsh');
                return 'commit';
            },
        }, f.deps);
        expect(f.boundaryFailures).toEqual([]);
        expect(f.calls.some(command => command.executable === 'ss')).toBe(true);
        expect(f.events[0]).toBe(mode === 'ask' ? 'prompt' : 'native');
        expect(f.launches).toHaveLength(1);
        expect(f.prompt).toHaveBeenCalledTimes(mode === 'ask' ? 1 : 0);
        expect(f.authentication).toEqual(mode === 'ask' ? ['one-use-password\n'] : []);
        expect(f.verifyCurrent).toHaveBeenCalledTimes(1);
        expect(MachineElevatedResultV1Schema.parse(result)).toEqual(result);
        expect(result.outcome).toBe('applied');
        expect(stages).toEqual([0, 1]);
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check', 'apply']);
        expect(MachineEffectInternalRequestSchema.parse(f.frames[0])).toMatchObject({ mode: 'check', basis, firewallIntent });
        const applied = MachineEffectInternalRequestSchema.parse(f.frames[1]);
        if (applied.mode !== 'apply' || !('plans' in applied)) throw new Error('Expected actual root-materialized plans');
        expect(applied.plans).toHaveLength(2);
        expect(applied.plans.map(entry => entry.plan.planDigest)).toEqual(stageDigests);
        const final = applied.plans[1]!.plan.steps[0]!;
        if (final.kind !== 'firewall') throw new Error('Expected native firewall program');
        expect(f.readTable()).toBe(final.rules);
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(final.rules);
    });

    it('preserves the missing retained SSH policy as a CHECK refusal before any APPLY', async () => {
        const f = await fixture('preauthorized');
        const initial: MachineRecipeStepV1 = { id: 'existing-firewall', kind: 'firewall',
            rules: 'table inet happier\ndelete table inet happier\ntable inet happier {\n chain input {\n type filter hook input priority -10; policy accept;\n ct state new drop\n }\n}\n' };
        await f.backend.apply(initial);
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
        }, ssh4: 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n' });
        // The OS command boundary cannot read the retained table's JSON policy.
        // Keep the real native observer, root CHECK and elevation settlement.
        const firewallIntent = MachineFirewallTransitionIntentV1Schema.parse({
            v: 1, kind: 'retainSsh', publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] }, caddy: {},
        });
        const onStage = vi.fn(async () => 'commit' as const);
        const result = await runElevatedMachineFirewallPlans({ machineId: 'machine', operationId: 'missing-ssh-policy',
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, firewallIntent, onStage,
        }, f.deps);
        expect(f.boundaryFailures).toEqual([]);
        expect(result).toMatchObject({ outcome: 'not_applied', reasonCode: 'native_check_unavailable',
            failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'retainedSshPolicy' } });
        expect(MachineElevatedResultV1Schema.parse(result)).toEqual(result);
        expect(onStage).not.toHaveBeenCalled();
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check']);
        expect(f.readTable()).toBe(initial.rules);
    });

    it('requires a fresh review before APPLY when reviewed service ingress overlaps actual protected SSH', async () => {
        const f = await fixture('ask');
        await f.setFirewallFacts({ interfaces: {
            ens18: [{ address: '10.10.0.4', netmask: '255.255.255.0', family: 'IPv4',
                mac: '00:00:00:00:00:01', internal: false, cidr: '10.10.0.4/24' }],
        }, ssh4: 'LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n' });
        const firewallIntent = MachineFirewallTransitionIntentV1Schema.parse({
            v: 1, kind: 'retainSsh', publicSsh: { kind: 'closed' },
            caddy: { publicBindings: [{
                requirementId: 'https', hostAddress: '0.0.0.0', hostPort: 2205,
                protocol: 'tcp', containerPort: 443, exposure: 'public',
            }] },
        });
        const onStage = vi.fn(async () => 'commit' as const);
        const result = await runElevatedMachineFirewallPlans({ machineId: 'machine', operationId: 'bounded-drift',
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, firewallIntent, onStage,
        }, f.deps);
        expect(f.boundaryFailures).toEqual([]);
        expect(MachineElevatedResultV1Schema.parse(result)).toEqual(result);
        expect(f.calls.some(command => command.executable === 'ss')).toBe(true);
        expect(f.calls.some(command => command.executable === '/usr/sbin/nft' && command.args.includes('-f'))).toBe(false);
        expect(f.readTable()).toBeUndefined();
        expect(await f.fs.lstat(f.disk(rulesPath)).then(() => true, () => false)).toBe(false);
        expect(onStage).not.toHaveBeenCalled();
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check']);
        expect(f.events[0]).toBe('prompt');
        expect(f.launches).toHaveLength(1);
        expect(f.prompt).toHaveBeenCalledTimes(1);
        expect(f.authentication).toEqual(['one-use-password\n']);
        expect(f.verifyCurrent).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ outcome: 'not_applied', reasonCode: 'plan_stale' });
    });

    it.each([
        { decision: 'undo', mode: 'preauthorized', retained: false },
        { decision: 'commit', mode: 'ask', retained: false },
        { decision: 'cancel', mode: 'ask', retained: false },
        { decision: 'commit', mode: 'ask', retained: true },
    ] as const)('holds original undo across A and FINAL in one $mode CHECK→APPLY, with $decision at the final verification boundary (retained=$retained)', async ({ decision, mode, retained }) => {
        const f = await fixture(mode, decision === 'cancel');
        const originalStep = { id: 'owned-firewall', kind: 'firewall', rules: `table inet happier
delete table inet happier
table inet happier {
  chain input {
    type filter hook input priority filter - 10; policy accept;
    ct state established,related accept
    iifname "lo" accept
    iifname "ens18" tcp dport 22 accept
    iifname "ens18" ct state new drop
  }
}
` } satisfies MachineRecipeStepV1;
        await f.backend.apply(originalStep);
        const originalBytes = await f.fs.readFile(f.disk(rulesPath), 'utf8');
        const originalUnit = await f.fs.readFile(f.disk(unitPath), 'utf8');
        const originalTable = f.readTable();
        const first = { ...originalStep, rules: originalStep.rules.replace('    iifname "ens18" ct state new drop',
            '    iifname "ens18" ip daddr 203.0.113.2 tcp dport 443 accept\n    iifname "ens18" ct state new drop') };
        const final = { ...first, rules: first.rules.replace('    iifname "ens18" tcp dport 22 accept\n', '') };
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const currentPlans = await Promise.all([first, final].map(async step => {
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend });
            return { plan };
        }));
        const plans = retained ? currentPlans.map(({ plan }) => ({ plan: retainedPlan(plan) })) : currentPlans;
        const admittedDigests = plans.map(entry => entry.plan.planDigest);
        if (retained) expect(admittedDigests).not.toEqual(currentPlans.map(entry => entry.plan.planDigest));
        expect(plans.map(entry => entry.plan.nativeFacts.map(fact => fact.status))).toEqual([['drifted'], ['drifted']]);
        const controller = new AbortController(), stages: number[] = [];
        const recovery: unknown[] = [], stageAuthorityReads: number[] = [];
        let closedPosture = false;
        const result = await runElevatedMachineFirewallPlans({ machineId: 'machine', operationId: 'operation', plans,
            signal: controller.signal,
            async onStage(stage) {
                const authorityReads = f.verifyCurrent.mock.calls.length;
                stages.push(stage.planIndex);
                recovery.push(Reflect.get(stage, 'recovery'));
                expect(await stage.verifyNative()).toBe(true);
                stageAuthorityReads.push(f.verifyCurrent.mock.calls.length - authorityReads);
                expect(f.readTable()).toContain('ip daddr 203.0.113.2 tcp dport 443 accept');
                if (stage.planIndex === 0) { expect(f.readTable()).toContain('tcp dport 22 accept'); return 'continue'; }
                expect(f.readTable()).not.toContain('tcp dport 22 accept');
                if (decision === 'cancel') controller.abort();
                if (decision === 'commit') closedPosture = true; // simulated P21 CAS boundary; P21 owns its actual persistence integration
                return decision === 'commit' ? 'commit' : 'undo';
            },
        }, f.deps);
        expect(f.boundaryFailures).toEqual([]);
        if (decision === 'cancel') expect(f.lateProgressAfterCancel()).toBe(true);
        expect(MachineElevatedResultV1Schema.parse(result)).toEqual(result);
        expect(stages).toEqual([0, 1]);
        expect(recovery).toEqual([
            { rules: { kind: 'file', content: originalBytes }, unit: { kind: 'file', content: originalUnit },
                table: originalTable, boot: { present: true, enabled: true, running: true } },
            { rules: { kind: 'file', content: first.rules }, unit: { kind: 'file', content: originalUnit },
                table: first.rules, boot: { present: true, enabled: true, running: true } },
        ]);
        expect(stageAuthorityReads).toEqual([0, 0]);
        expect(f.verifyCurrent).toHaveBeenCalledTimes(1);
        expect(f.launches).toHaveLength(1);
        expect(plans.map(entry => entry.plan.planDigest)).toEqual(admittedDigests);
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check', 'apply']);
        expect(f.authentication).toEqual(mode === 'ask' ? ['one-use-password\n'] : []);
        expect(f.prompt).toHaveBeenCalledTimes(mode === 'ask' ? 1 : 0);
        expect(closedPosture).toBe(decision === 'commit');
        if (decision === 'commit') expect(result.outcome).toBe('applied');
        else {
            expect(result).toMatchObject({ outcome: 'not_applied', reasonCode: 'cancelled',
                restoration: { status: 'verified', recovery: recovery[0] } });
            expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(originalBytes);
            expect(f.readTable()).toContain('tcp dport 22 accept');
        }
    });

    it('rejects modified retained firewall intent before root CHECK reads native facts', async () => {
        const f = await fixture('ask');
        const step = { id: 'owned-firewall', kind: 'firewall', rules: `table inet happier
delete table inet happier
table inet happier {
  chain input {
    type filter hook input priority filter - 10; policy accept;
    tcp dport 22 accept
    ct state new drop
  }
}
` } satisfies MachineRecipeStepV1;
        const plan = retainedPlan(await checkMachineSetupEffectPlan({
            basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, steps: [step], backend: f.backend,
        }));
        expect(plan.nativeFacts[0]?.status).toBe('drifted');
        const nativeReads = f.calls.length;
        const onStage = vi.fn(async () => 'commit' as const);
        const result = await runElevatedMachineFirewallPlans({ machineId: 'machine', operationId: 'changed-retained',
            plans: [{ plan: { ...plan, steps: [{ ...step, rules: step.rules.replace('dport 22', 'dport 2205') }] } }], onStage,
        }, f.deps);
        expect(f.boundaryFailures).toEqual([]);
        expect(MachineElevatedResultV1Schema.parse(result)).toEqual(result);
        expect(result).toEqual({ outcome: 'not_applied', reasonCode: 'plan_stale' });
        expect(f.calls.slice(nativeReads)).toEqual([]);
        expect(onStage).not.toHaveBeenCalled();
        expect(f.frames.filter(frame => frame && typeof frame === 'object' && 'mode' in frame)
            .map(frame => Reflect.get(frame as object, 'mode'))).toEqual(['check']);
        expect(f.launches).toHaveLength(1);
        expect(f.verifyCurrent).toHaveBeenCalledTimes(1);
    });
});
