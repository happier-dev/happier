import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineRecipeStepV1Schema, MachineFirewallTransitionIntentV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { applyMachineSetupEffectPlan, applyMachineSetupEffectPlans, checkMachineSetupEffectPlan,
    createMachineFirewallTransitionObservationStepV1, readMachineFirewallTransitionFactsV1,
    materializeMachineFirewallTransitionV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

// Only OS boundaries are substituted. Bytes, inode identity, chmod, staging,
// rename and the complete typed interpreter remain real.
const os = vi.hoisted(() => ({ root: '', owners: new Map<number, { uid: number; gid: number }>(),
    interfaces: {} as NodeJS.Dict<NetworkInterfaceInfo[]> }));
vi.mock('node:os', async importOriginal => ({
    ...await importOriginal<typeof import('node:os')>(), networkInterfaces: () => os.interfaces,
}));
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    const path = (value: import('node:fs').PathLike) => typeof value === 'string' && value.startsWith('/')
        && !value.startsWith(os.root + '/') && value !== os.root ? join(os.root, value) : value;
    return { ...fs,
        async lstat(value: import('node:fs').PathLike) {
            const stat = await fs.lstat(path(value));
            const owner = os.owners.get(stat.ino) ?? (stat.isDirectory() ? { uid: 0, gid: 0 } : { uid: 1001, gid: 1001 });
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
        unlink: (value: import('node:fs').PathLike) => fs.unlink(path(value)),
    };
});

const rulesPath = '/etc/happier/firewall/rules.nft';
const unitPath = '/etc/systemd/system/happier-firewall.service';
const rules = 'table inet happier\ndelete table inet happier\ntable inet happier {\n  chain input {\n    type filter hook input priority filter - 10; policy accept;\n    ct state established,related accept\n    iifname "lo" accept\n    ct state new drop\n  }\n  chain forward {\n    type filter hook forward priority filter - 10; policy accept;\n    ct state established,related accept\n    ct direction original ct state new drop\n  }\n}\n';
const basis = { kind: 'bootstrap' as const, managedId: 'managed', operationId: 'operation', admittedInputDigest: 'a'.repeat(64) };
const roots: string[] = [];
function nativeInterface(address: string): NetworkInterfaceInfo {
    const common = { address, netmask: address.includes(':') ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
        mac: '00:11:22:33:44:55', internal: false, cidr: null };
    return address.includes(':') ? { ...common, family: 'IPv6', scopeid: 0 } : { ...common, family: 'IPv4' };
}
afterEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
    os.root = ''; os.owners.clear(); os.interfaces = {};
});

async function fixture() {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    os.root = await fs.mkdtemp(join(tmpdir(), 'happier-firewall-')); roots.push(os.root);
    const disk = (path: string) => path.startsWith(os.root + '/') ? path : join(os.root, path);
    for (const path of ['/etc/happier/firewall', '/etc/systemd/system', '/usr/sbin', '/proc/1']) await fs.mkdir(disk(path), { recursive: true, mode: 0o755 });
    const rootFile = async (path: string, bytes: string, mode: number) => {
        await fs.writeFile(disk(path), bytes, { mode });
        os.owners.set((await fs.lstat(disk(path))).ino, { uid: 0, gid: 0 });
    };
    await rootFile('/usr/sbin/nft', 'system executable fixture', 0o755);
    await rootFile('/proc/1/comm', 'systemd\n', 0o644);
    let nftAvailable = true, validate = true, bootVerification = true, active = false, enabled = false, table: string | undefined;
    let routes4: unknown = [{ dst: 'default', dev: 'ens18', gateway: '10.10.0.1' }], routes6: unknown = [];
    os.interfaces = { ens18: [nativeInterface('10.10.0.4')], tun42: [nativeInterface('100.96.0.4')] };
    let listeners4 = '', listeners6 = '', networkReadable = true, nativePolicy: unknown = { nftables: [] };
    const calls: MachineSetupNativeCommand[] = [];
    const backend = createMachineSetupNativeBackend({ run: async command => {
        calls.push(command);
        const args = command.args;
        if (command.executable === 'getent') return { code: 0, stdout: args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
        if (command.executable === 'ip' || command.executable === 'ss') {
            if (!networkReadable) return { code: 1, stdout: '', stderr: 'kernel observation unavailable' };
            if (command.executable === 'ip') return { code: 0,
                stdout: JSON.stringify(args.includes('-6') ? routes6 : routes4), stderr: '' };
            return { code: 0, stdout: args.includes('-6') ? listeners6 : listeners4, stderr: '' };
        }
        if (command.executable === '/usr/sbin/nft') {
            if (!nftAvailable) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
            if (args.includes('--version')) return { code: 0, stdout: 'nftables v1.0.9\n', stderr: '' };
            if (args.includes('-c')) return { code: validate ? 0 : 1, stdout: '', stderr: '' };
            if (args.includes('-j') && args.includes('tables')) return { code: 0, stdout: JSON.stringify({ nftables: table ? [{ table: { family: 'inet', name: 'happier' } }] : [] }), stderr: '' };
            if (args.includes('-j') && args.includes('table')) return { code: table ? 0 : 1, stdout: JSON.stringify(nativePolicy), stderr: '' };
            if (args.includes('list')) return { code: table ? 0 : 1, stdout: table ?? '', stderr: '' };
            if (args.includes('-f')) { table = await fs.readFile(disk(args[args.indexOf('-f') + 1]!), 'utf8'); return { code: 0, stdout: '', stderr: '' }; }
            if (args[0] === 'delete') { table = undefined; return { code: 0, stdout: '', stderr: '' }; }
        }
        if (command.executable === 'systemctl') {
            if (args[0] === 'show') {
                const present = await fs.lstat(disk(unitPath)).then(() => true, () => false);
                return { code: 0, stdout: `LoadState=${present ? 'loaded' : 'not-found'}\nUnitFileState=${enabled && bootVerification ? 'enabled' : 'disabled'}\nActiveState=${active ? 'active' : 'inactive'}\n`, stderr: '' };
            }
            if (args[0] === 'enable') enabled = true;
            else if (args[0] === 'disable') enabled = false;
            else if (args[0] === 'start' || args[0] === 'restart') active = true;
            else if (args[0] === 'stop') active = false;
            else if (args[0] !== 'daemon-reload') throw new Error('Unexpected systemd boundary');
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native boundary ${command.executable}`);
    } });
    const step = MachineRecipeStepV1Schema.parse({ id: 'firewall', kind: 'firewall', rules });
    return { fs, disk, backend, step, calls, rootFile, readEffectiveTable: () => table,
        setNetwork(value: { routes4?: unknown; routes6?: unknown; interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]> }) {
            if ('routes4' in value) routes4 = value.routes4;
            if ('routes6' in value) routes6 = value.routes6;
            if (value.interfaces) os.interfaces = value.interfaces;
        },
        async listenSsh(ipv4: string, ipv6 = '', uid = 0) {
            await fs.mkdir(disk('/proc/412'), { recursive: true, mode: 0o755 });
            await rootFile('/usr/sbin/sshd', 'system sshd executable fixture', 0o755);
            await rootFile('/proc/412/status', `Name:\tsshd\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`, 0o444);
            await fs.symlink('/usr/sbin/sshd', disk('/proc/412/exe'));
            listeners4 = ipv4; listeners6 = ipv6;
        },
        async listenNonSsh(ipv4: string, ipv6 = '') {
            await fs.mkdir(disk('/proc/413'), { recursive: true, mode: 0o755 });
            await rootFile('/usr/sbin/service-proxy', 'non-SSH native service fixture', 0o755);
            await fs.symlink('/usr/sbin/service-proxy', disk('/proc/413/exe'));
            listeners4 = ipv4; listeners6 = ipv6;
        },
        setNativePolicy(value: unknown) { nativePolicy = value; },
        unreadableNetwork() { networkReadable = false; },
        missingNft() { nftAvailable = false; }, rejectValidation() { validate = false; },
        rejectBootVerification() { bootVerification = false; } };
}

type NativeStage = Readonly<{ verify(): Promise<boolean>; commit(): Promise<void>; undo(): Promise<void> }>;
async function stage(f: Awaited<ReturnType<typeof fixture>>, step = f.step): Promise<NativeStage> {
    // The real backend is exercised; this runtime lookup keeps the intended
    // RED compilable before its typed stage port has co-landed.
    const start: unknown = Reflect.get(f.backend, 'stage');
    if (typeof start !== 'function') throw new Error('Native firewall stage port is missing');
    return await Reflect.apply(start, f.backend, [step]) as NativeStage;
}

describe('native owned firewall', () => {
    it('observes route-selected external and exposure-selected private interfaces and every live SSH endpoint without guessing from private addresses', async () => {
        const f = await fixture();
        await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\nLISTEN 0 128 0.0.0.0:2206 0.0.0.0:* users:(("sshd",pid=412,fd=4))\n');
        const step = MachineRecipeStepV1Schema.parse({ ...f.step, exposures: [{ requirementId: 'caddy-origin',
            hostAddress: '100.96.0.4', hostPort: 18080, containerPort: 8080, protocol: 'tcp', exposure: 'privateNetwork',
            providerId: 'selected-provider', networkIdentity: 'selected-network' }] });
        const observation = await f.backend.observe(step);
        expect(observation.status).toBe('drifted');
        expect(observation.facts).toMatchObject({
            firewallTransition: { status: 'available', externalInterfaces: ['ens18'],
                privateInterfaces: [{ providerId: 'selected-provider', networkIdentity: 'selected-network', hostAddress: '100.96.0.4', interfaceName: 'tun42' }] },
        });
        const transition = observation.facts.firewallTransition;
        const endpoints: unknown = transition !== null && typeof transition === 'object' ? Reflect.get(transition, 'retainedSshEndpoints') : undefined;
        expect(endpoints).toEqual(expect.arrayContaining([
                { interfaceName: 'ens18', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
                { interfaceName: 'tun42', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
                { interfaceName: 'ens18', hostAddress: '0.0.0.0', port: 2206, sourceCidrs: ['0.0.0.0/0'] },
                { interfaceName: 'tun42', hostAddress: '0.0.0.0', port: 2206, sourceCidrs: ['0.0.0.0/0'] },
            ]));
        expect(endpoints).toHaveLength(4);
        // No owned chain existed: neutral permits cannot weaken foreign chains.
        await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.calls.some(call => call.args.includes('-f') || call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
    });

    it('reports a positively empty live SSH listener set rather than inventing port 22', async () => {
        const f = await fixture();
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'drifted', facts: {
            firewallTransition: { status: 'available', externalInterfaces: ['ens18'], privateInterfaces: [], retainedSshEndpoints: [] },
        } });
    });

    it('retains a non-root sshd listener through the protected system executable identity, not the process uid', async () => {
        const f = await fixture();
        await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n', '', 1001);
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'drifted', facts: {
            firewallTransition: { status: 'available', retainedSshEndpoints: [
                { interfaceName: 'ens18', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
                { interfaceName: 'tun42', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
            ] },
        } });
    });

    it('does not turn a user-writable executable merely named sshd into a retained SSH allow', async () => {
        const f = await fixture();
        await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n');
        await f.fs.mkdir(f.disk('/home/daemon'), { recursive: true, mode: 0o755 });
        await f.fs.writeFile(f.disk('/home/daemon/sshd'), 'not a system SSH executable', { mode: 0o755 });
        os.owners.set((await f.fs.lstat(f.disk('/home/daemon/sshd'))).ino, { uid: 1001, gid: 1001 });
        await f.fs.unlink(f.disk('/proc/412/exe'));
        await f.fs.symlink('/home/daemon/sshd', f.disk('/proc/412/exe'));
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'drifted', facts: {
            firewallTransition: { status: 'unavailable', requiredFact: 'sshExecutableIdentity' },
        } });
    });

    it.each(['unreadable kernel facts', 'unmapped selected private address', 'ambiguous selected private address', 'external interface selected as private'] as const)(
        'does not fabricate native transition facts for %s', async failure => {
            const f = await fixture();
            if (failure === 'unreadable kernel facts') f.unreadableNetwork();
            if (failure === 'unmapped selected private address') f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4')] } });
            if (failure === 'ambiguous selected private address') f.setNetwork({ interfaces: {
                ens18: [nativeInterface('10.10.0.4')], tun42: [nativeInterface('100.96.0.4')], tun43: [nativeInterface('100.96.0.4')],
            } });
            const step = MachineRecipeStepV1Schema.parse({ ...f.step, exposures: [{ requirementId: 'private-origin',
                hostAddress: failure === 'external interface selected as private' ? '10.10.0.4' : '100.96.0.4',
                hostPort: 18080, protocol: 'tcp', exposure: 'privateNetwork', providerId: 'selected-provider', networkIdentity: 'selected-network' }] });
            expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
            await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        });

    it('retains the source restriction proved by the existing owned native policy, not a listener-derived global allow', async () => {
        const f = await fixture();
        const original = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: rules.replace('ct state new drop', 'iifname "ens18" ip saddr 198.51.100.0/24 tcp dport 2205 accept\n    ct state new drop') });
        await f.backend.apply(original);
        await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n');
        f.setNativePolicy({ nftables: [
            { table: { family: 'inet', name: 'happier' } },
            { chain: { family: 'inet', table: 'happier', name: 'input', type: 'filter', hook: 'input', prio: -10, policy: 'accept' } },
            { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [
                { match: { op: 'in', left: { ct: { key: 'state' } }, right: { set: ['established', 'related'] } } }, { accept: null },
            ] } },
            { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [{ match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'lo' } }, { accept: null }] } },
            { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [
                { match: { op: '==', left: { meta: { key: 'iifname' } }, right: 'ens18' } },
                { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: { prefix: { addr: '198.51.100.0', len: 24 } } } },
                { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 2205 } }, { accept: null },
            ] } },
            { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [{ match: { op: '==', left: { ct: { key: 'state' } }, right: 'new' } }, { drop: null }] } },
        ] });
        expect(await f.backend.observe(original)).toMatchObject({ status: 'satisfied', facts: {
            firewallTransition: { status: 'available', retainedSshEndpoints: [
                { interfaceName: 'ens18', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['198.51.100.0/24'] },
                { interfaceName: 'tun42', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: [] },
            ] },
        } });
    });

    it('keeps ordinary firewall readiness while refusing transition facts for an unsupported existing owned policy', async () => {
        const f = await fixture();
        const originalRules = rules.replace('ct state new drop', 'jump custom\n    ct state new drop').replace('  chain forward', '  chain custom {\n    tcp dport 2205 accept\n  }\n  chain forward');
        const original = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: originalRules });
        await f.backend.apply(original);
        await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n');
        f.setNativePolicy({ nftables: [
            { table: { family: 'inet', name: 'happier' } },
            { chain: { family: 'inet', table: 'happier', name: 'input', type: 'filter', hook: 'input', prio: -10, policy: 'accept' } },
            { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [{ jump: { target: 'custom' } }] } },
        ] });
        expect(await f.backend.observe(original)).toMatchObject({ status: 'satisfied', facts: {
            firewallTransition: { status: 'unavailable', requiredFact: 'retainedSshPolicy' },
        } });
        expect(f.readEffectiveTable()).toBe(originalRules);
    });

    it('does not mutate native firewall or boot state for an already satisfied staged plan', async () => {
        const f = await fixture();
        await f.backend.apply(f.step);
        const before = f.calls.length;
        const staged = await stage(f);
        expect(await staged.verify()).toBe(true);
        await staged.commit();
        expect(f.calls.slice(before).filter(call => call.executable === '/usr/sbin/nft' && call.args.includes('-f') && !call.args.includes('-c')
            || call.executable === 'systemctl' && call.args[0] !== 'show')).toEqual([]);
    });

    it('does not certify original restoration when an already satisfied stage loses native boot proof before undo', async () => {
        const f = await fixture();
        await f.backend.apply(f.step);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        const before = f.calls.length;
        const result = await applyMachineSetupEffectPlans({ plans: [{ plan }], backend: f.backend,
            onStaged: async () => { f.rejectBootVerification(); return 'undo'; } });
        expect(result.status).toBe('outcome_unknown');
        expect(Reflect.get(result, 'restoration')).toBeUndefined();
        expect(f.calls.slice(before).filter(call => call.executable === '/usr/sbin/nft' && call.args.includes('-f') && !call.args.includes('-c')
            || call.executable === 'systemctl' && call.args[0] !== 'show')).toEqual([]);
    });

    it('reports a positively empty default-route set without inventing an external-interface requirement', async () => {
        const f = await fixture();
        f.setNetwork({ routes4: [], routes6: [] });
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'drifted', facts: {
            firewallTransition: { status: 'available', externalInterfaces: [], privateInterfaces: [], retainedSshEndpoints: [] },
        } });
    });

    it.each(['scoped IPv6', 'unmapped concrete'] as const)('does not silently report an empty available SSH set for a %s listener', async bind => {
        const f = await fixture();
        f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4'), nativeInterface('fe80::4')] } });
        await f.listenSsh(bind === 'unmapped concrete' ? 'LISTEN 0 128 203.0.113.4:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n' : '',
            bind === 'scoped IPv6' ? 'LISTEN 0 128 [fe80::4%ens18]:2205 [::]:* users:(("sshd",pid=412,fd=3))\n' : '');
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'drifted', facts: {
            firewallTransition: { status: 'unavailable', requiredFact: 'sshListeners' },
        } });
    });

    it.each(['absent', 'present'] as const)('exposes serializable recovery from the same captured %s snapshot used by native undo', async initial => {
        const f = await fixture();
        if (initial === 'present') await f.backend.apply(f.step);
        const previousRules = initial === 'present' ? await f.fs.readFile(f.disk(rulesPath), 'utf8') : null;
        const previousUnit = initial === 'present' ? await f.fs.readFile(f.disk(unitPath), 'utf8') : null;
        const previousTable = f.readEffectiveTable() ?? null;
        const changed = MachineRecipeStepV1Schema.parse({ ...f.step, rules: rules.replace('ct state new drop', 'tcp dport 443 accept\n    ct state new drop') });
        const staged = await stage(f, changed);
        const recovery: unknown = Reflect.get(staged, 'recovery');
        const expected = {
            rules: previousRules === null ? { kind: 'absent' } : { kind: 'file', content: previousRules },
            unit: previousUnit === null ? { kind: 'absent' } : { kind: 'file', content: previousUnit },
            table: previousTable, boot: { present: initial === 'present', enabled: initial === 'present', running: initial === 'present' },
        };
        try {
            expect(recovery).toEqual(expected);
            expect(JSON.parse(JSON.stringify(recovery))).toEqual(expected);
        } finally { await staged.undo(); }
        expect(f.readEffectiveTable() ?? null).toBe(previousTable);
    });

    it('persists only root-owned exact rules and the independent native boot unit through the typed interpreter', async () => {
        const f = await fixture();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect(plan.nativeFacts[0]?.status).toBe('drifted');
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(rules);
        expect((await f.fs.lstat(f.disk(rulesPath))).mode & 0o777).toBe(0o600);
        expect(os.owners.get((await f.fs.lstat(f.disk(rulesPath))).ino)).toEqual({ uid: 0, gid: 0 });
        expect(await f.fs.readFile(f.disk(unitPath), 'utf8')).toBe('[Unit]\nDescription=Happier owned firewall\nAfter=network-pre.target docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f /etc/happier/firewall/rules.nft\n\n[Install]\nWantedBy=multi-user.target\n');
        expect(os.owners.get((await f.fs.lstat(f.disk(unitPath))).ino)).toEqual({ uid: 0, gid: 0 });
        expect((await f.fs.lstat(f.disk(unitPath))).mode & 0o022).toBe(0);
        expect(f.calls.some(call => call.executable === '/usr/sbin/nft' && call.args.includes('-c'))).toBe(true);
        expect((await f.backend.observe(f.step)).status).toBe('satisfied');
    });

    it('reports system nft absence as unsupported, with no persistence or native mutation', async () => {
        const f = await fixture(); f.missingNft();
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.calls.some(call => call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
    });

    it('does not replace prior rules or boot state when native candidate validation fails', async () => {
        const f = await fixture(); f.rejectValidation();
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('failed');
        await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(f.fs.lstat(f.disk(unitPath))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects includes and foreign-table commands before persistence or native activation', async () => {
        const f = await fixture();
        for (const value of [rules + 'include "/tmp/daemon-owned.nft"\n', rules.replace('chain input', 'include "/tmp/owned.nft"\n  chain input'),
            rules.replace('table inet happier {', 'table inet foreign {'), rules + 'flush ruleset\n', rules + 'delete table inet foreign\n',
            rules.replace('ct state new drop', '}\n}\nflush ruleset\n#'), rules.replace('chain input', 'in\\\nclude "/tmp/wrapper.nft"\n chain input')]) {
            expect(await f.backend.observe(MachineRecipeStepV1Schema.parse({ ...f.step, rules: value }))).toMatchObject({ status: 'unavailable', reason: 'validation_failed' });
        }
        await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.calls.filter(call => call.executable === '/usr/sbin/nft' && call.args.includes('-f'))).toHaveLength(0);
    });

    it('keeps braces and reserved words in strings/comments inert while validating the exact candidate', async () => {
        const f = await fixture();
        const value = rules.replace('ct state new drop', `ct state new drop comment ${JSON.stringify('quoted } include flush " end')} # } include "/tmp/no"\n`);
        const step = MachineRecipeStepV1Schema.parse({ ...f.step, rules: value });
        await f.backend.apply(step);
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(value);
    });

    it('undo restores the exact prior rules, unit and effective owned table after a staged replacement', async () => {
        const f = await fixture();
        await f.backend.apply(f.step);
        const beforeRules = await f.fs.readFile(f.disk(rulesPath), 'utf8');
        const beforeUnit = await f.fs.readFile(f.disk(unitPath), 'utf8');
        const changed = MachineRecipeStepV1Schema.parse({ ...f.step, rules: rules.replace('ct state new drop', 'meta l4proto tcp tcp dport 443 accept\n    ct state new drop') });
        const staged = await stage(f, changed);
        expect(await staged.verify()).toBe(true);
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).not.toBe(beforeRules);
        await staged.undo();
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(beforeRules);
        expect(await f.fs.readFile(f.disk(unitPath), 'utf8')).toBe(beforeUnit);
        expect((await f.backend.observe(f.step)).status).toBe('satisfied');
    });

    it('reports boot verification failure and restores the previously absent state', async () => {
        const f = await fixture(); f.rejectBootVerification();
        await expect(stage(f)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        await expect(f.fs.lstat(f.disk(rulesPath))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(f.fs.lstat(f.disk(unitPath))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a daemon-owned system nft executable and symlinked executable before any native dispatch', async () => {
        const f = await fixture();
        const executable = f.disk('/usr/sbin/nft');
        const inode = (await f.fs.lstat(executable)).ino;
        os.owners.set(inode, { uid: 1001, gid: 1001 });
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(f.calls).toHaveLength(0);
        await f.fs.unlink(executable);
        await f.fs.symlink('/tmp/daemon-wrapper', executable);
        expect(await f.backend.observe(f.step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(f.calls).toHaveLength(0);
    });

    it.each(['reachability refusal', 'cancellation'] as const)('retains the first undo across two reviewed stages and verifies original SSH restoration after %s', async termination => {
        const f = await fixture();
        const controller = new AbortController();
        const original = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: rules.replace('ct state new drop', 'meta l4proto tcp tcp dport 22 accept\n    ct state new drop') });
        await f.backend.apply(original);
        const originalBytes = await f.fs.readFile(f.disk(rulesPath), 'utf8');
        const originalUnit = await f.fs.readFile(f.disk(unitPath), 'utf8');
        const originalTable = f.readEffectiveTable();
        const stageARules = rules.replace('ct state new drop', 'meta l4proto tcp tcp dport { 22, 443 } accept\n    ct state new drop');
        const stageA = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: stageARules });
        const plans = await Promise.all([stageA, f.step].map(async step => {
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend });
            return { plan };
        }));
        const observedStages: number[] = [];
        const recovery: unknown[] = [];
        let closedPostureWritten = false;
        // Reachability transport and persistence are the future P21 consumer's
        // system boundaries; this test does not implement its posture transition.
        const finalReachabilityProbe = async () => false;
        const postureCas = async () => { closedPostureWritten = true; };
        const input = { plans, backend: f.backend, signal: controller.signal,
            onStaged: async (stage: Readonly<{ planIndex: number }>) => {
                const { planIndex } = stage;
                observedStages.push(planIndex);
                recovery.push(Reflect.get(stage, 'recovery'));
                if (planIndex === 0) {
                    // Genuine native-effect boundary state: the intermediate
                    // policy retains the existing SSH permit.
                    expect(f.readEffectiveTable()).toContain('dport { 22, 443 } accept');
                    return 'continue' as const;
                }
                // The exact external/daemon reachability probe fails before
                // P21 may write closed posture; it requests full invocation undo.
                if (await finalReachabilityProbe()) { await postureCas(); return 'commit' as const; }
                if (termination === 'cancellation') controller.abort();
                return 'undo' as const;
            } };
        const result = await applyMachineSetupEffectPlans(input);
        expect(observedStages).toEqual([0, 1]);
        expect(result.status).toBe('cancelled');
        expect(recovery).toEqual([
            { rules: { kind: 'file', content: originalBytes }, unit: { kind: 'file', content: originalUnit },
                table: originalTable, boot: { present: true, enabled: true, running: true } },
            { rules: { kind: 'file', content: stageARules }, unit: { kind: 'file', content: originalUnit },
                table: stageARules, boot: { present: true, enabled: true, running: true } },
        ]);
        const restoration: unknown = Reflect.get(result, 'restoration');
        expect(restoration).toEqual({ status: 'verified', recovery: recovery[0] });
        if (restoration === null || typeof restoration !== 'object') throw new Error('Missing native restoration proof');
        expect(Reflect.get(restoration, 'recovery')).toBe(recovery[0]);
        expect(closedPostureWritten).toBe(false);
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(originalBytes);
        expect(f.readEffectiveTable()).toContain('tcp dport 22 accept');
        expect((await f.backend.observe(original)).status).toBe('satisfied');
    });

    it('keeps staged recovery unknown when the native owner cannot verify restored boot state', async () => {
        const f = await fixture();
        const original = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: rules.replace('ct state new drop', 'meta l4proto tcp tcp dport 22 accept\n    ct state new drop') });
        await f.backend.apply(original);
        const originalBytes = await f.fs.readFile(f.disk(rulesPath), 'utf8');
        const stageA = MachineRecipeStepV1Schema.parse({ ...f.step,
            rules: rules.replace('ct state new drop', 'meta l4proto tcp tcp dport { 22, 443 } accept\n    ct state new drop') });
        const plans = await Promise.all([stageA, f.step].map(async step => ({
            plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }),
        })));
        const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend,
            onStaged: async ({ planIndex }) => {
                if (planIndex === 0) return 'continue';
                // This is the existing systemctl observation boundary, not a
                // mocked undo result. Native undo must reject its unproven boot.
                f.rejectBootVerification();
                return 'undo';
            } });
        expect(result.status).toBe('outcome_unknown');
        expect(Reflect.get(result, 'restoration')).toBeUndefined();
        expect(await f.fs.readFile(f.disk(rulesPath), 'utf8')).toBe(originalBytes);
        expect(f.readEffectiveTable()).toContain('tcp dport 22 accept');
        expect((await f.backend.observe(original)).status).toBe('drifted');
    });
});

function boundedTransitionIntent(publicSsh: { kind: 'closed' } | { kind: 'open'; port: number; sourceCidrs: string[] }) {
  return MachineFirewallTransitionIntentV1Schema.parse({ v: 1, kind: 'retainSsh', publicSsh,
    caddy: { publicBindings: [{ requirementId: 'domain-https', hostAddress: '203.0.113.9', hostPort: 443,
      containerPort: 8443, protocol: 'tcp', exposure: 'public' }],
      privateBinding: { exposure: { requirementId: 'private-origin', hostAddress: '100.96.0.4', hostPort: 18080,
        containerPort: 8080, protocol: 'tcp', exposure: 'privateNetwork', providerId: 'selected-provider', networkIdentity: 'selected-network' },
        interfaceName: 'tun42', sourceRanges: ['100.96.0.0/16'] } } });
}

describe('native firewall bounded transition owner', () => {
  it('observes wildcard SSH bindings on every actual non-default interface in both families', async () => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4'), nativeInterface('2001:db8::4')],
      secondary: [nativeInterface('192.0.2.9'), nativeInterface('2001:db8:2::9')],
      tun42: [nativeInterface('100.96.0.4')], bridgeA: [nativeInterface('172.28.0.1')] } });
    await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n',
      'LISTEN 0 128 [::]:2206 [::]:* users:(("sshd",pid=412,fd=4))\n');
    const intent = boundedTransitionIntent({ kind: 'closed' });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    expect(native).toMatchObject({ status: 'available', externalInterfaces: ['ens18'] });
    if (native.status !== 'available') throw new Error('Missing actual native facts');
    expect(native.retainedSshEndpoints).toEqual(expect.arrayContaining([
      { interfaceName: 'secondary', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
      { interfaceName: 'secondary', hostAddress: '::', port: 2206, sourceCidrs: ['::/0'] },
      { interfaceName: 'bridgeA', hostAddress: '0.0.0.0', port: 2205, sourceCidrs: ['0.0.0.0/0'] },
    ]));
    expect(f.calls.some(call => call.args.includes('-f') || call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
  });

  it('closes undeclared non-SSH secondary host/published ingress while leaving ordinary container egress and inter-bridge forwarding outside the denial scope', async () => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4')],
      secondary: [nativeInterface('192.0.2.9'), nativeInterface('2001:db8:2::9')],
      tun42: [nativeInterface('100.96.0.4')], bridgeA: [nativeInterface('172.28.0.1')], bridgeB: [nativeInterface('172.29.0.1')] } });
    await f.listenNonSsh('LISTEN 0 128 192.0.2.9:9090 0.0.0.0:* users:(("service-proxy",pid=413,fd=3))\n'
      + 'LISTEN 0 128 192.0.2.9:19090 0.0.0.0:* users:(("service-proxy",pid=413,fd=4))\n');
    // There are NO SSH endpoints. Endpoint-specific SSH drops cannot satisfy
    // this Machine closure; host9090/published19090->container9090 are undeclared.
    const intent = boundedTransitionIntent({ kind: 'closed' });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    expect(native).toMatchObject({ status: 'available', retainedSshEndpoints: [] });
    const materialized = materializeMachineFirewallTransitionV1(intent, native);
    if (materialized.status !== 'ready') throw new Error(`Unexpected materialization ${materialized.reason}`);
    const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
    const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend, onStaged: async staged => {
      expect(await staged.verifyNative()).toBe(true);
      const table = f.readEffectiveTable()!;
      const inputRows = table.split('  chain input {')[1]!.split('  chain forward {')[0]!.split('\n').map(line => line.trim());
      const forwardRows = table.split('  chain forward {')[1]!.split('\n').map(line => line.trim());
      expect(inputRows).toContain('ct state new drop');
      expect(inputRows).toContain('ct state established,related accept');
      expect(inputRows).toContain('iifname "lo" accept');
      expect(forwardRows).toContain('ct state new ct direction original ct status dnat drop');
      const drops = forwardRows.filter(line => line.endsWith(' drop'));
      expect(drops.length).toBeGreaterThan(0);
      // This is a deciding native OUTPUT contract, not a fake packet engine:
      // every forward denial needs DNAT. Ordinary source-NAT egress/direct
      // inter-bridge traffic do not match. This tests the current Docker scope,
      // not arbitrary routed DNAT; packet delivery is the existing Lima gate.
      expect(drops).toEqual(['ct state new ct direction original ct status dnat drop']);
      expect(forwardRows).toContain('ct state established,related accept');
      expect(table).not.toContain('tcp dport 9090 accept');
      expect(table).not.toContain('ct original proto-dst 19090 accept');
      expect(table).toContain('iifname "tun42" ip saddr 100.96.0.0/16 ip daddr 100.96.0.4 tcp dport 18080 accept');
      return staged.planIndex === 0 ? 'continue' : 'commit';
    } });
    expect(result.status).toBe('applied');
  });

  it('keeps an explicitly public concrete secondary Caddy binding without reclassifying it by the default-route interface', async () => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4')], secondary: [nativeInterface('192.0.2.9')], tun42: [nativeInterface('100.96.0.4')] } });
    const base = boundedTransitionIntent({ kind: 'closed' });
    const intent = MachineFirewallTransitionIntentV1Schema.parse({ ...base, caddy: { ...base.caddy,
      publicBindings: [{ ...base.caddy.publicBindings![0], hostAddress: '192.0.2.9' }] } });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    const materialized = materializeMachineFirewallTransitionV1(intent, native);
    if (materialized.status !== 'ready') throw new Error(`Unexpected materialization ${materialized.reason}`);
    const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
    const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend, onStaged: async staged => {
      expect(await staged.verifyNative()).toBe(true);
      const table = f.readEffectiveTable()!;
      expect(table.split('\n').map(line => line.trim())).toContain('ip daddr 192.0.2.9 tcp dport 443 accept');
      expect(table.split('\n').map(line => line.trim())).toContain('meta l4proto tcp ct original ip daddr 192.0.2.9 ct original proto-dst 443 accept');
      expect(table).not.toContain('iifname "ens18" ip daddr 192.0.2.9 tcp dport 443 accept');
      return staged.planIndex === 0 ? 'continue' : 'commit';
    } });
    expect(result.status).toBe('applied');
  });

  it.each(['open', 'closed'] as const)('enforces the exact observed SSH scope on a non-default interface through A and FINAL %s', async desired => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4')],
      secondary: [nativeInterface('192.0.2.9')], tun42: [nativeInterface('100.96.0.4')] } });
    await f.listenSsh('LISTEN 0 128 192.0.2.9:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n');
    const allow = 'iifname "secondary" ip daddr 192.0.2.9 ip saddr 198.51.100.0/24 tcp dport 2205 accept';
    await f.backend.apply(MachineRecipeStepV1Schema.parse({ ...f.step,
      rules: rules.replace('    ct state new drop', `    ${allow}\n    ct state new drop`) }));
    const match = (left: unknown, right: unknown) => ({ match: { op: '==', left, right } });
    f.setNativePolicy({ nftables: [
      { chain: { family: 'inet', table: 'happier', name: 'input', type: 'filter', hook: 'input', policy: 'drop' } },
      { rule: { family: 'inet', table: 'happier', chain: 'input', expr: [
        match({ meta: { key: 'iifname' } }, 'secondary'),
        match({ payload: { protocol: 'ip', field: 'daddr' } }, '192.0.2.9'),
        match({ payload: { protocol: 'ip', field: 'saddr' } }, { prefix: { addr: '198.51.100.0', len: 24 } }),
        match({ payload: { protocol: 'tcp', field: 'dport' } }, 2205), { accept: null },
      ] } },
    ] });
    const intent = boundedTransitionIntent(desired === 'closed' ? { kind: 'closed' }
      : { kind: 'open', port: 2299, sourceCidrs: ['0.0.0.0/0'] });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    expect(native).toMatchObject({ status: 'available', ownedTable: 'present', externalInterfaces: ['ens18'],
      retainedSshEndpoints: [{ interfaceName: 'secondary', hostAddress: '192.0.2.9', port: 2205, sourceCidrs: ['198.51.100.0/24'] }] });
    const materialized = materializeMachineFirewallTransitionV1(intent, native);
    if (materialized.status !== 'ready') throw new Error(`Unexpected materialization ${materialized.reason}`);
    const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
    const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend, onStaged: async staged => {
      expect(await staged.verifyNative()).toBe(true);
      const table = f.readEffectiveTable()!;
      const inputRules = table.split('  chain input {')[1]!.split('  chain forward {')[0]!.split('\n').map(line => line.trim());
      expect(inputRules).toContain('ct state new drop');
      const deny = 'ct state new drop';
      const retained = staged.planIndex === 0 || desired === 'open';
      expect(table.includes(allow)).toBe(retained);
      if (retained) expect(table.indexOf(allow)).toBeLessThan(table.indexOf(deny));
      expect(table.indexOf('ct state established,related accept')).toBeLessThan(table.indexOf(deny));
      expect(table).not.toContain('tcp dport 2205 drop'); // No secondary per-endpoint mechanism.
      expect(table).not.toContain('ip saddr 0.0.0.0/0 tcp dport 2205 accept');
      expect(table).not.toContain('tcp dport 2299 accept');
      return staged.planIndex === 0 ? 'continue' : 'commit';
    } });
    expect(result.status).toBe('applied');
  });

  it('refuses overlapping Caddy and ensured fresh-firewall scalar SSH scopes before native APPLY even with no live SSH listener', async () => {
    const f = await fixture();
    const base = boundedTransitionIntent({ kind: 'open', port: 443, sourceCidrs: ['198.51.100.0/24'] });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(base)));
    expect(native).toMatchObject({ status: 'available', ownedTable: 'absent', retainedSshEndpoints: [] });
    expect(materializeMachineFirewallTransitionV1(base, native)).toEqual({ status: 'review_required', reason: 'plan_changed' });
    expect(f.readEffectiveTable()).toBeUndefined();
    expect(f.calls.some(call => call.args.includes('-f') || call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
  });

  it.each(['open', 'closed'] as const)('retains every observed fresh-firewall SSH endpoint in A and materializes exact FINAL %s', async desired => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4'), nativeInterface('2001:db8::4')], tun42: [nativeInterface('100.96.0.4')] } });
    await f.listenSsh('LISTEN 0 128 0.0.0.0:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n',
      'LISTEN 0 128 [::]:2206 [::]:* users:(("sshd",pid=412,fd=4))\n');
    const intent = boundedTransitionIntent(desired === 'closed' ? { kind: 'closed' }
      : { kind: 'open', port: 2299, sourceCidrs: ['198.51.100.0/24'] });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    expect(native).toMatchObject({ status: 'available', ownedTable: 'absent' });
    const materialized = materializeMachineFirewallTransitionV1(intent, native);
    if (materialized.status !== 'ready') throw new Error(`Unexpected materialization ${materialized.reason}`);
    const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
    const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend, onStaged: async staged => {
      expect(await staged.verifyNative()).toBe(true);
      const table = f.readEffectiveTable()!;
      const keepObserved = staged.planIndex === 0 || desired === 'open';
      expect(table.includes('iifname "ens18" meta nfproto ipv4 ip saddr 0.0.0.0/0 tcp dport 2205 accept')).toBe(keepObserved);
      expect(table.includes('iifname "tun42" meta nfproto ipv4 ip saddr 0.0.0.0/0 tcp dport 2205 accept')).toBe(keepObserved);
      expect(table.includes('iifname "ens18" meta nfproto ipv6 ip6 saddr ::/0 tcp dport 2206 accept')).toBe(keepObserved);
      expect(table.includes('iifname "ens18" meta nfproto ipv4 ip saddr 198.51.100.0/24 tcp dport 2299 accept')).toBe(staged.planIndex === 1 && desired === 'open');
      expect(table).not.toContain('ip6 saddr ::/0 tcp dport 2299 accept');
      return staged.planIndex === 0 ? 'continue' : 'commit';
    } });
    expect(result.status).toBe('applied');
  });

  it.each(['same address', 'wildcard', 'previously closed', 'other address', 'other family', 'other port'] as const)(
    'materializes disjoint scopes and refuses conflicting SSH/service scope for %s binding', async scope => {
      const f = await fixture();
      f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4'), nativeInterface('10.10.0.99'), nativeInterface('2001:db8::4')], tun42: [nativeInterface('100.96.0.4')] } });
      const sshAddress = scope === 'wildcard' || scope === 'other family' ? '0.0.0.0' : '10.10.0.4';
      await f.listenSsh(`LISTEN 0 128 ${sshAddress}:22 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n`);
      if (scope === 'previously closed') {
        await f.backend.apply(f.step);
        f.setNativePolicy({ nftables: [{ chain: { family: 'inet', table: 'happier', name: 'input', type: 'filter', hook: 'input', policy: 'drop' } }] });
      }
      const base = boundedTransitionIntent({ kind: 'closed' });
      const intent = MachineFirewallTransitionIntentV1Schema.parse({ ...base, caddy: { ...base.caddy,
        publicBindings: [{ ...base.caddy.publicBindings![0],
          hostAddress: scope === 'other address' ? '10.10.0.99' : scope === 'other family' ? '2001:db8::4' : '10.10.0.4',
          hostPort: scope === 'other port' ? 443 : 22 }] } });
      const before = f.calls.length;
      const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
      expect(native.status).toBe('available');
      const materialized = materializeMachineFirewallTransitionV1(intent, native);
      if (scope === 'same address' || scope === 'wildcard' || scope === 'previously closed') {
        expect(materialized).toEqual({ status: 'review_required', reason: 'plan_changed' });
        expect(f.readEffectiveTable()).toBe(scope === 'previously closed' ? rules : undefined);
        expect(f.calls.slice(before).some(call => call.args.includes('-f') || call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
      } else {
        if (materialized.status !== 'ready') throw new Error(`Disjoint scope refused: ${materialized.reason}`);
        const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
        const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend,
          onStaged: async staged => { expect(await staged.verifyNative()).toBe(true); return staged.planIndex === 0 ? 'continue' : 'commit'; } });
        expect(result.status).toBe('applied');
      }
    });

  it('keeps every pre-existing concrete SSH address, port, interface and source scope without adding the scalar endpoint to an existing firewall', async () => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4'), nativeInterface('2001:db8::4')], tun42: [nativeInterface('100.96.0.4')] } });
    await f.listenSsh('LISTEN 0 128 10.10.0.4:2205 0.0.0.0:* users:(("sshd",pid=412,fd=3))\n',
      'LISTEN 0 128 [2001:db8::4]:2206 [::]:* users:(("sshd",pid=412,fd=4))\n');
    const original = { ...f.step, rules: rules.replace('    ct state new drop',
      '    iifname "ens18" ip daddr 10.10.0.4 ip saddr 198.51.100.0/24 tcp dport 2205 accept\n'
      + '    iifname "ens18" ip6 daddr 2001:db8::4 ip6 saddr 2001:db8:abcd::/48 tcp dport 2206 accept\n    ct state new drop') };
    await f.backend.apply(original);
    // Native `nft -j list table` response, not a mock of policy interpretation.
    const match = (left: unknown, right: unknown) => ({ match: { op: '==', left, right } });
    const nativeRule = (family: 'ip' | 'ip6', address: string, port: number, source: string, length: number) => ({ rule: {
      family: 'inet', table: 'happier', chain: 'input', expr: [
        match({ meta: { key: 'iifname' } }, 'ens18'),
        match({ payload: { protocol: family, field: 'daddr' } }, address),
        match({ payload: { protocol: family, field: 'saddr' } }, { prefix: { addr: source, len: length } }),
        match({ payload: { protocol: 'tcp', field: 'dport' } }, port), { accept: null },
      ],
    } });
    f.setNativePolicy({ nftables: [{ chain: { family: 'inet', table: 'happier', name: 'input', type: 'filter', hook: 'input', policy: 'drop' } },
      nativeRule('ip', '10.10.0.4', 2205, '198.51.100.0', 24), nativeRule('ip6', '2001:db8::4', 2206, '2001:db8:abcd::', 48)] });
    const intent = boundedTransitionIntent({ kind: 'open', port: 2299, sourceCidrs: ['0.0.0.0/0', '::/0'] });
    const observation = await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent));
    const native = readMachineFirewallTransitionFactsV1(observation);
    expect(native).toMatchObject({ status: 'available', ownedTable: 'present', retainedSshEndpoints: [
      { interfaceName: 'ens18', hostAddress: '10.10.0.4', port: 2205, sourceCidrs: ['198.51.100.0/24'] },
      { interfaceName: 'ens18', hostAddress: '2001:db8::4', port: 2206, sourceCidrs: ['2001:db8:abcd::/48'] },
    ] });
    const materialized = materializeMachineFirewallTransitionV1(intent, native);
    if (materialized.status !== 'ready') throw new Error(`Unexpected native materialization ${materialized.reason}`);
    const plans = await Promise.all(materialized.steps.map(async step => ({ plan: await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend }) })));
    const result = await applyMachineSetupEffectPlans({ plans, backend: f.backend, onStaged: async staged => {
      expect(await staged.verifyNative()).toBe(true);
      const table = f.readEffectiveTable()!;
      expect(table).toContain('iifname "ens18" ip daddr 10.10.0.4 ip saddr 198.51.100.0/24 tcp dport 2205 accept');
      expect(table).toContain('iifname "ens18" ip6 daddr 2001:db8::4 ip6 saddr 2001:db8:abcd::/48 tcp dport 2206 accept');
      expect(table).not.toContain('tcp dport 2299 accept');
      expect(table).not.toContain('ip saddr 0.0.0.0/0 tcp dport 2205 accept');
      expect(table).not.toContain('ip6 saddr ::/0 tcp dport 2206 accept');
      return staged.planIndex === 0 ? 'continue' : 'commit';
    } });
    expect(result.status).toBe('applied');
  });

  it('returns a fresh-review outcome before any native mutation when the actual private interface exceeds the reviewed binding', async () => {
    const f = await fixture();
    f.setNetwork({ interfaces: { ens18: [nativeInterface('10.10.0.4')], actualTunnel: [nativeInterface('100.96.0.4')] } });
    const intent = boundedTransitionIntent({ kind: 'closed' });
    const native = readMachineFirewallTransitionFactsV1(await f.backend.observe(createMachineFirewallTransitionObservationStepV1(intent)));
    expect(native).toMatchObject({ status: 'available', privateInterfaces: [{ interfaceName: 'actualTunnel' }] });
    expect(materializeMachineFirewallTransitionV1(intent, native)).toEqual({ status: 'review_required', reason: 'plan_changed' });
    expect(f.readEffectiveTable()).toBeUndefined();
    expect(f.calls.some(call => call.args.includes('-f') || call.executable === 'systemctl' && call.args[0] !== 'show')).toBe(false);
  });
});
