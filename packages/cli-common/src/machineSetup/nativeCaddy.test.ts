import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, chmod } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { DeploymentDomainMachineTopologyV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { getRelayAccessProvider } from '../relayAccess/registry.js';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import { ensureNativeCaddyContainer, nativeCaddyImage, readCaddyContainerFirewallExposures, observeNativeCaddyContainer, createNativeCaddyBindings, connectNativeCaddyNetworks, hashNativeCaddyPassword, createCaddyContainerSetupSteps, type NativeCaddySetupInput } from './nativeCaddy.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };

it.skipIf(process.platform === 'win32')('prepares Caddy on a fresh host with no Happier state parent and remains idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-caddy-fresh-')); roots.push(root);
    const stateDirectory = join(root, 'happier', 'caddy');
    const adminDirectory = join(root, 'happier-caddy');
    const steps = createCaddyContainerSetupSteps({ containerName: 'happier-caddy', stateDirectory, adminDirectory,
        daemonGroup: userInfo().username, daemonGroupId: process.getgid!(), initialConfig: '{}', originPort: 8080, routedNetworks: [] });
    // Local identity resolution is the OS boundary; directory creation, exact
    // ownership/modes, file publication and both interpreters stay real.
    const backend = createMachineSetupNativeBackend({ run: async command => {
        if (command.executable !== 'getent') throw new Error('Unexpected native command');
        return ok(command.args.includes('passwd')
            ? `${command.args.at(-1)}:x:${process.getuid!()}:${process.getgid!()}::/home/test:/bin/sh\n`
            : `${command.args.at(-1)}:x:${process.getgid!()}:\n`);
    } });
    for (let attempt = 0; attempt < 2; attempt++) {
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect(await readFile(join(stateDirectory, 'initial.json'), 'utf8')).toBe('{}');
        expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o750);
        expect((await lstat(adminDirectory)).mode & 0o777).toBe(0o750);
    }
    await chmod(join(root, 'happier'), 0o700);
    const conflict = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan: conflict, backend })).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect((await lstat(join(root, 'happier'))).mode & 0o777).toBe(0o700);
});

async function inspectCaddyFromCatalog(run: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>, dockerHost?: string) {
    const provider = getRelayAccessProvider({ kind: 'builtin', id: 'caddy' });
    expect(provider?.inspect).toBeDefined();
    return provider.inspect!({ config: { provider: { kind: 'builtin', id: 'caddy' }, config: {}, credentialRefs: [] },
        ctx: { env: dockerHost ? { DOCKER_HOST: dockerHost } : {}, upstreamUrl: null, runCommand: async request => {
            const result = await run({ executable: request.command, args: [...request.args], signal: request.signal });
            return { command: request.command, args: request.args, exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
        } },
    });
}

it('hashes the exact password through native Caddy stdin and clears the encoded secret after settlement', async () => {
    const password = ' leading\r unicode🐙 trailing ';
    const bcryptHash = '$2a$14$' + 'a'.repeat(53);
    let bytes: Uint8Array | undefined;
    const result = await hashNativeCaddyPassword({ dockerHost: 'unix:///selected-docker.sock', containerId: 'owned-caddy-id', password }, {
        run: async command => {
            expect(command.executable).toBe('docker');
            expect(command.args).toEqual(['--host', 'unix:///selected-docker.sock', 'exec', '--interactive', 'owned-caddy-id',
                'caddy', 'hash-password', '--algorithm', 'bcrypt']);
            expect(command.args.join(' ')).not.toContain(password);
            expect(command.env).toBeUndefined();
            bytes = command.inputBytes;
            expect(Buffer.from(bytes!).toString('utf8')).toBe(password + '\n');
            return ok(bcryptHash + '\n');
        },
    });
    expect(result).toEqual({ status: 'ready', bcryptHash });
    expect(bytes?.every(byte => byte === 0)).toBe(true);
});

it.each(['', 'first\nsecond'])('refuses passwords outside native non-TTY line grammar without invoking Docker: %j', async password => {
    let calls = 0;
    expect(await hashNativeCaddyPassword({ containerId: 'owned-caddy-id', password }, { run: async () => { calls++; return ok(); } }))
        .toEqual({ status: 'unavailable', reason: 'domain_credential_unavailable' });
    expect(calls).toBe(0);
});

it('keeps native hashing failures sanitized, clears stdin bytes and leaves bcrypt length decisions to Caddy', async () => {
    const password = '🐙'.repeat(30);
    let bytes: Uint8Array | undefined;
    let calls = 0;
    expect(await hashNativeCaddyPassword({ containerId: 'owned-caddy-id', password }, { run: async command => {
        calls++;
        bytes = command.inputBytes;
        throw new Error(password);
    } })).toEqual({ status: 'unavailable', reason: 'native_effect_failed' });
    expect(calls).toBe(1);
    expect(bytes?.every(byte => byte === 0)).toBe(true);
    expect(await hashNativeCaddyPassword({ containerId: 'owned-caddy-id', password: 'valid' }, { run: async () => ok('not-bcrypt\n') }))
        .toEqual({ status: 'unavailable', reason: 'domain_credential_unavailable' });
});

async function fixture(privateNetwork = true, socketFixture = true, deferredAdmin = false) {
    // Unix socket paths have a platform byte limit; use a short owned root for
    // the actual transport fixture even under the executor's long TMPDIR.
    const root = await mkdtemp(socketFixture ? '/tmp/hc-' : join(tmpdir(), 'happier-caddy-')); roots.push(root);
    const input: NativeCaddySetupInput = {
        dockerHost: 'unix:///run/docker-selected.sock', containerName: 'happier-caddy',
        stateDirectory: join(root, 'state'), adminDirectory: join(root, 'admin'),
        daemonGroup: 'happier', daemonGroupId: process.getgid!(), originPort: 9381,
        initialConfig: JSON.stringify({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {} } } }),
        routedNetworks: ['routed-a', 'routed-b'],
        ...(privateNetwork ? { privateBinding: { interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], exposure: {
            requirementId: 'caddy-private', exposure: 'privateNetwork' as const, providerId: 'tailscale', networkIdentity: 'tailnet-a',
            hostAddress: '100.70.80.90', hostPort: 9381, containerPort: 9381, protocol: 'tcp' as const,
        } } } : {}),
    };
    // The separately executed native root fixture proves these produced setup
    // steps against real getent/chown. This Docker-boundary suite consumes the
    // real interpreter's settled no-op result, with no identity substitution.
    await mkdir(join(input.stateDirectory, 'config', 'caddy'), { recursive: true });
    const commands: MachineSetupNativeCommand[] = [];
    type Container = { Id: string; Name: string; Config: { Image: string; Cmd: string[]; User: string; Labels: Record<string, string> };
        HostConfig: { NetworkMode: string; RestartPolicy: { Name: string }; Binds: null; Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }>; PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> };
        NetworkSettings: { Networks: Record<string, object>; Ports: Record<string, Array<{ HostIp: string; HostPort: string }>> }; State: { Running: boolean } };
    let container: Container | undefined;
    let exitCode: number | undefined, exited: (() => void) | undefined;
    let loseCreateResponse = false;
    const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
        commands.push(command);
        expect(command.executable).toBe('docker');
        if (command.args[0] === '--host') expect(command.args[1]).toBe(input.dockerHost);
        const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
        if (args[0] === 'container' && args[1] === 'ls') return ok(container ? JSON.stringify(container.Id) + '\n' : '');
        if (args[0] === 'container' && args[1] === 'inspect') return container ? ok(JSON.stringify([container])) : { code: 1, stdout: '', stderr: 'missing' };
        if (args[0] === 'container' && args[1] === 'create') {
            const mounts: Container['HostConfig']['Mounts'] = [];
            const labels: Record<string, string> = {};
            const portBindings: Container['HostConfig']['PortBindings'] = {};
            for (let i = 2; i < args.length; i++) {
                if (args[i] === '--mount') {
                    const parts = Object.fromEntries(args[++i]!.split(',').map(value => value.split('=')));
                    mounts.push({ Type: parts.type!, Source: parts.src!, Target: parts.dst!, ReadOnly: parts.readonly === 'true' });
                } else if (args[i] === '--label') { const [key, value] = args[++i]!.split('='); labels[key!] = value!; }
                else if (args[i] === '--publish') {
                    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+):(\d+\/tcp)$/.exec(args[++i]!);
                    if (!match) throw new Error('Invalid native publish binding');
                    portBindings[match[4]!] = [{ HostIp: (match[1] ?? match[2])!, HostPort: match[3]! }];
                }
            }
            container = { Id: 'owned-container-id', Name: `/${args[args.indexOf('--name') + 1]}`, Config: { Image: nativeCaddyImage, Cmd: [...args.slice(args.indexOf(nativeCaddyImage) + 1)],
                User: args[args.indexOf('--user') + 1]!, Labels: labels },
                HostConfig: { NetworkMode: args[args.indexOf('--network') + 1]!, RestartPolicy: { Name: args[args.indexOf('--restart') + 1]! }, Binds: null, Mounts: mounts, PortBindings: portBindings },
                NetworkSettings: { Networks: { [args[args.indexOf('--network') + 1]!]: { IPAddress: '172.18.0.2', GlobalIPv6Address: 'fd00:18::2' } }, Ports: portBindings }, State: { Running: false } };
            if (loseCreateResponse) throw new Error('lost Docker response');
            return ok(container.Id);
        }
        if (args[0] === 'network' && args[1] === 'connect') { container!.NetworkSettings.Networks[args[2]!] = { IPAddress: '172.19.0.2' }; return ok(); }
        if (args[0] === 'container' && args[1] === 'start') {
            exitCode = undefined;
            container!.State.Running = true;
            if (!deferredAdmin && !adminServer && !await lstat(join(input.adminDirectory, 'admin.sock')).then(() => true, () => false)) {
                await serveAdmin(JSON.parse(input.initialConfig));
            }
            return ok(container!.Id);
        }
        if (args[0] === 'container' && args[1] === 'wait') return new Promise(resolve => {
            const finish = (result: MachineSetupNativeCommandResult) => {
                command.signal?.removeEventListener('abort', abort); exited = undefined; resolve(result);
            };
            const abort = () => finish({ code: 1, stdout: '', stderr: '' });
            exited = () => finish(ok(String(exitCode)));
            if (command.signal?.aborted) abort();
            else if (exitCode !== undefined) exited();
            else command.signal?.addEventListener('abort', abort, { once: true });
        });
        if (args[0] === 'container' && args[1] === 'stop') { container!.State.Running = false; return ok(); }
        if (args[0] === 'container' && args[1] === 'rm') { container = undefined; return ok(); }
        throw new Error(`Unexpected Docker operation: ${args[0]} ${args[1]}`);
    };
    const backend = createMachineSetupNativeBackend({ run });
    const unapproved = await checkMachineSetupEffectPlan({ basis, steps: [], backend });
    let setupResult = await applyMachineSetupEffectPlan({ plan: { ...unapproved, planDigest: 'b'.repeat(64) }, backend });
    const setup = async () => {
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [], backend });
        setupResult = await applyMachineSetupEffectPlan({ plan, backend });
        expect(setupResult).toMatchObject({ status: 'applied' });
        await mkdir(input.adminDirectory, { recursive: true });
        await writeFile(join(input.stateDirectory, 'initial.json'), input.initialConfig);
    };
    let adminServer: Server | undefined, adminConfig: unknown, reads = 0;
    const serveAdmin = async (config: unknown) => {
        await mkdir(input.adminDirectory, { recursive: true });
        await writeFile(join(input.stateDirectory, 'initial.json'), input.initialConfig);
        adminConfig = config; reads = 0;
        if (adminServer) return { reads: () => reads };
        const server = createServer((request, response) => {
            expect(request.url).toBe('/config/');
            expect(request.method).toBe('GET');
            reads++;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(adminConfig));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(join(input.adminDirectory, 'admin.sock'), resolve);
        });
        servers.push(server);
        adminServer = server;
        return { reads: () => reads };
    };
    const closeAdmin = async () => {
        if (!adminServer) return;
        const server = adminServer; adminServer = undefined;
        servers.splice(servers.indexOf(server), 1);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    return { input, commands, run, setup, serveAdmin, closeAdmin, options: () => ({ run, setupResult }), readContainer: () => container!, loseCreate: () => { loseCreateResponse = true; },
        exit: (code: number) => { container!.State.Running = false; exitCode = code; exited?.(); } };
}

it.skipIf(process.platform === 'win32')('does not report a started container ready before its live Caddy admin config is available', async () => {
    const f = await fixture(false, true, true); await f.setup();
    await mkdir(f.input.adminDirectory, { recursive: true });
    await writeFile(join(f.input.stateDirectory, 'initial.json'), f.input.initialConfig);
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const controller = new AbortController();
    const result = ensureNativeCaddyContainer(f.input, { ...f.options(), run: async command => {
        const result = await f.run(command);
        if (command.args.includes('start')) started();
        return result;
    }, signal: controller.signal });
    try {
        await start;
        let settled = false;
        void result.then(() => { settled = true; }, () => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled, 'Docker start is not Caddy admin readiness').toBe(false);
        await f.serveAdmin(JSON.parse(f.input.initialConfig));
        expect(await result).toMatchObject({ status: 'ready' });
        expect(f.commands.filter(command => command.args[3] === 'wait')).toHaveLength(1);
        const before = f.commands.length;
        expect(await ensureNativeCaddyContainer(f.input, f.options())).toMatchObject({ status: 'ready' });
        expect(f.commands.slice(before).some(command => ['create', 'start', 'stop', 'rm', 'wait'].includes(command.args[3]!))).toBe(false);
    } finally { controller.abort(); await result.catch(() => {}); }
});

it.skipIf(process.platform === 'win32').each(['cancelled', 'exited'] as const)('settles Caddy startup when the operation is %s', async outcome => {
    const f = await fixture(false, true, true); await f.setup();
    const controller = new AbortController();
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const result = ensureNativeCaddyContainer(f.input, { ...f.options(), signal: controller.signal, run: async command => {
        const result = await f.run(command);
        if (command.args.includes('start')) started();
        return result;
    } });
    try {
        await start;
        if (outcome === 'cancelled') {
            controller.abort();
            await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        } else {
            f.exit(1);
            expect(await result).toMatchObject({ status: 'unavailable', reason: 'native_effect_failed', details: {
                failure: { kind: 'native_effect_failed', requiredFact: 'caddyAdminConfig' },
            } });
        }
        expect(f.commands.some(command => command.args.includes('rm') || command.args.includes('stop'))).toBe(false);
    } finally { controller.abort(); await result.catch(() => {}); }
});

it.skipIf(process.platform === 'win32')('retains an observed container exit while the admin response is still pending', async () => {
    const f = await fixture(false, true, true); await f.setup();
    let requested!: () => void;
    const request = new Promise<void>(resolve => { requested = resolve; });
    const server = createServer(() => { requested(); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(f.input.adminDirectory, 'admin.sock'), resolve); });
    servers.push(server);
    const controller = new AbortController();
    const result = ensureNativeCaddyContainer(f.input, { ...f.options(), signal: controller.signal });
    try {
        await request;
        f.exit(1);
        expect(await result).toMatchObject({ status: 'unavailable', reason: 'native_effect_failed', details: {
            failure: { kind: 'native_effect_failed', requiredFact: 'caddyAdminConfig' },
        } });
    } finally { controller.abort(); await result.catch(() => {}); }
});

it.skipIf(process.platform === 'win32')('names the unavailable live admin config without claiming container rollback', async () => {
    const f = await fixture(false, true); await f.setup();
    const input = { ...f.input, publicBindings: [{ requirementId: 'https', exposure: 'public' as const,
        hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443, protocol: 'tcp' as const }] };
    await ensureNativeCaddyContainer(input, f.options());
    await f.closeAdmin();
    await mkdir(f.input.adminDirectory, { recursive: true });
    await writeFile(join(f.input.stateDirectory, 'initial.json'), f.input.initialConfig);
    expect(await observeNativeCaddyContainer({ dockerHost: f.input.dockerHost }, { run: f.run })).toMatchObject({
        status: 'unavailable', reason: 'required_fact_unavailable', details: {
            failure: { requiredFact: 'caddyAdminConfig', errorCode: 'ENOENT' },
            remedy: expect.stringContaining('caddyAdminConfig'),
        },
    });
    expect(await ensureNativeCaddyContainer(input, f.options())).toMatchObject({
        status: 'unavailable', reason: 'required_fact_unavailable', details: {
            failure: { requiredFact: 'caddyAdminConfig', errorCode: 'ENOENT' },
            remedy: expect.stringContaining('caddyAdminConfig'),
        },
    });
    expect(f.readContainer().State.Running).toBe(true);
    expect(f.commands.some(command => command.args.includes('rm') || command.args.includes('stop'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('observes current owned Caddy listeners through its real mounted Unix admin socket, never desired config', async () => {
    const f = await fixture(true, true); await f.setup();
    const input = { ...f.input, publicBindings: [{ requirementId: 'https', exposure: 'public' as const,
        hostAddress: '203.0.113.7', hostPort: 8443, containerPort: 443, protocol: 'tcp' as const }] };
    await ensureNativeCaddyContainer(input, f.options());
    const admin = await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true }, routes: [] },
        edge: { listen: [':443'], tls_connection_policies: [{}], routes: [] },
    } } } });
    const before = f.commands.length;
    const observation = await observeNativeCaddyContainer(input, { run: f.run });
    expect(observation).toEqual({ status: 'ready',
        containerId: 'owned-container-id', containerName: input.containerName,
        adminSocketPath: join(input.adminDirectory, 'admin.sock'), networkNames: ['routed-a', 'routed-b'],
        servers: [
            { serverId: 'local', listen: [':9381'], tls: false, automaticHttpsDisabled: true,
                endpoints: [{ hostAddress: '100.70.80.90', hostPort: 9381, containerPort: 9381 }] },
            { serverId: 'edge', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                endpoints: [{ hostAddress: '203.0.113.7', hostPort: 8443, containerPort: 443 }] },
        ],
        containerOrigins: [{ serverId: 'local', networkName: 'routed-a', service: 'http://172.18.0.2:9381' }],
    });
    expect(DeploymentDomainMachineTopologyV1Schema.parse({ machineId: 'machine', installationId: 'installation',
        dockerEngineId: 'engine', privateNetworks: [], replicas: [], caddy: observation }).caddy.containerOrigins)
        .toEqual([{ serverId: 'local', networkName: 'routed-a', service: 'http://172.18.0.2:9381' }]);
    expect(admin.reads()).toBe(1);
    expect(await inspectCaddyFromCatalog(f.run, input.dockerHost)).toEqual({ kind: 'confirmed', facts: {
        state: 'ready', ingress: { https: { hostname: 'custom', ports: [8443], paths: true } },
    } });
    expect(admin.reads()).toBe(2);
    expect(f.commands.slice(before).every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});

it.skipIf(process.platform === 'win32')('reports only plain listeners reachable through the actual primary container network, including IPv6', async () => {
    const f = await fixture(false, true); await f.setup();
    // Default bridge has no container-name DNS contract. Its observed address
    // still supplies the local connector endpoint without a host publication.
    await ensureNativeCaddyContainer({ ...f.input, routedNetworks: ['bridge', 'other'] }, f.options());
    const admin = await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        plain: { listen: [':9381', 'tcp/0.0.0.0:9381', '[fd00:18::2]:9382', 'tcp6/[::]:9383',
            '172.19.0.2:9384', '127.0.0.1:9385', 'udp/:9386', 'unix//run/app.sock'], automatic_https: { disable: true } },
        tls: { listen: [':443'], automatic_https: { disable: true }, tls_connection_policies: [{}] },
        automatic: { listen: [':9443'] },
    } } } });
    const before = f.commands.length;
    const observation = await observeNativeCaddyContainer(f.input, { run: f.run });
    const topology = DeploymentDomainMachineTopologyV1Schema.parse({ machineId: 'machine', installationId: 'installation',
        dockerEngineId: 'engine', privateNetworks: [], replicas: [], caddy: observation });
    expect(topology.caddy.containerOrigins).toEqual([
        { serverId: 'plain', networkName: 'bridge', service: 'http://172.18.0.2:9381' },
        { serverId: 'plain', networkName: 'bridge', service: 'http://[fd00:18::2]:9382' },
        { serverId: 'plain', networkName: 'bridge', service: 'http://[fd00:18::2]:9383' },
    ]);
    expect(topology.caddy.servers.every(server => server.endpoints.length === 0)).toBe(true);
    expect(admin.reads()).toBe(1);
    expect(f.commands.slice(before).map(command => command.args[2])).toEqual(['container', 'container']);
    f.readContainer().HostConfig.NetworkMode = 'unobserved';
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toMatchObject({ status: 'ready', containerOrigins: [] });
});

it('assembles bindings from exact admitted exposures and the selected observed private network', async () => {
    const f = await fixture();
    const exposure = f.input.privateBinding!.exposure;
    const network = { provider: { kind: 'builtin' as const, id: 'tailscale' }, networkIdentity: 'tailnet-a', displayName: null,
        dnsName: null, addresses: ['100.70.80.90'], interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: null, state: 'ready' as const };
    const publicBinding = { requirementId: 'https', exposure: 'public' as const,
        hostAddress: '203.0.113.7', hostPort: 443, containerPort: 443, protocol: 'tcp' as const };
    expect(createNativeCaddyBindings({ originPort: f.input.originPort, exposures: [exposure, publicBinding], privateNetworks: [network] }))
        .toEqual({ status: 'ready', privateBinding: f.input.privateBinding, publicBindings: [publicBinding] });
    expect(createNativeCaddyBindings({ originPort: f.input.originPort, exposures: [exposure], privateNetworks: [{ ...network, networkIdentity: 'other' }] }))
        .toEqual({ status: 'unavailable', reason: 'private_scope_unenforceable' });
});

it.skipIf(process.platform === 'win32')('does not project a Docker-published port through a loopback-only Caddy listener', async () => {
    const f = await fixture(true, true); await f.setup();
    await ensureNativeCaddyContainer(f.input, f.options());
    await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: ['127.0.0.1:9381'], automatic_https: { disable: true } },
    } } } });
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toMatchObject({ status: 'ready',
        servers: [{ serverId: 'local', endpoints: [] }] });
});

it.skipIf(process.platform === 'win32')('reports private origins only for ready admitted network addresses and keeps Tunnel origins unpublished', async () => {
    const f = await fixture(true, true); await f.setup();
    await ensureNativeCaddyContainer(f.input, f.options());
    await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
    } } } });
    const network = { provider: { kind: 'builtin' as const, id: 'tailscale' }, networkIdentity: 'tailnet-a', displayName: null,
        dnsName: null, addresses: ['100.70.80.90'], interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: null, state: 'ready' as const };
    expect(await observeNativeCaddyContainer({ ...f.input, privateNetworks: [network] }, { run: f.run })).toMatchObject({ status: 'ready',
        privateOrigins: [{ serverId: 'local', endpoint: '100.70.80.90:9381', network }] });
    expect(await observeNativeCaddyContainer({ ...f.input, privateNetworks: [{ ...network, addresses: ['100.70.80.91'] }] }, { run: f.run }))
        .toMatchObject({ status: 'ready', privateOrigins: [] });
    f.readContainer().NetworkSettings.Ports = {};
    expect(await observeNativeCaddyContainer({ ...f.input, privateNetworks: [network] }, { run: f.run }))
        .toMatchObject({ status: 'ready', servers: [{ serverId: 'local', endpoints: [] }], privateOrigins: [] });
    expect(createNativeCaddyBindings({ originPort: f.input.originPort, exposures: [], privateNetworks: [] }))
        .toEqual({ status: 'ready', publicBindings: [] });
});

it.skipIf(process.platform === 'win32')('does not classify a public HTTP listener on a private address as the admitted private origin', async () => {
    const f = await fixture(true, true); await f.setup();
    const input = { ...f.input, publicBindings: [{ requirementId: 'http', exposure: 'public' as const,
        hostAddress: '100.70.80.90', hostPort: 80, containerPort: 80, protocol: 'tcp' as const }] };
    await ensureNativeCaddyContainer(input, f.options());
    await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
        public_http: { listen: [':80'], automatic_https: { disable: true } },
    } } } });
    const network = { provider: { kind: 'builtin' as const, id: 'tailscale' }, networkIdentity: 'tailnet-a', displayName: null,
        dnsName: null, addresses: ['100.70.80.90'], interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: null, state: 'ready' as const };
    expect(await observeNativeCaddyContainer({ ...input, privateNetworks: [network] }, { run: f.run })).toMatchObject({ status: 'ready',
        privateOrigins: [{ serverId: 'local', endpoint: '100.70.80.90:9381', network }] });
    expect(await observeNativeCaddyContainer({ dockerHost: input.dockerHost, containerName: input.containerName, privateNetworks: [network] }, { run: f.run }))
        .toMatchObject({ status: 'ready', privateOrigins: [] });
});

it('distinguishes absent, stopped, foreign and unreadable native containers without setup or start', async () => {
    const f = await fixture();
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'needs_setup' });
    expect(await inspectCaddyFromCatalog(f.run, f.input.dockerHost)).toEqual({ kind: 'unknown', code: 'needs_setup' });
    await f.setup(); await ensureNativeCaddyContainer(f.input, f.options());
    const before = f.commands.length;
    f.readContainer().State.Running = false;
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'stopped', containerId: 'owned-container-id' });
    expect(await inspectCaddyFromCatalog(f.run, f.input.dockerHost)).toEqual({ kind: 'confirmed', facts: { state: 'stopped' } });
    f.readContainer().Config.Labels = {};
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect(await inspectCaddyFromCatalog(f.run, f.input.dockerHost)).toEqual({ kind: 'unknown', code: 'foreign_effect_conflict' });
    expect(await inspectCaddyFromCatalog(async () => ({ code: 1, stdout: '', stderr: 'denied' }), f.input.dockerHost))
        .toEqual({ kind: 'unknown', code: 'required_fact_unavailable' });
    expect(await observeNativeCaddyContainer(f.input, { run: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }))
        .toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable', details: {
            failure: { requiredFact: 'caddyContainer' },
        } });
    expect(f.commands.slice(before).every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});

it.skipIf(process.platform === 'win32')('refuses an unreachable or changed admin socket without treating the mounted seed as live evidence', async () => {
    const f = await fixture(true, true); await f.setup();
    await ensureNativeCaddyContainer(f.input, f.options());
    await f.closeAdmin();
    await writeFile(join(f.input.stateDirectory, 'initial.json'), f.input.initialConfig);
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable',
        details: { failure: { requiredFact: 'caddyAdminConfig', errorCode: 'ENOENT' } } });
    await f.serveAdmin({ admin: { listen: 'localhost:2019' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
    } } } });
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable',
        details: { failure: { requiredFact: 'caddyAdminConfig' } } });
});

it.skipIf(process.platform === 'win32')('discovers the actual owned Caddy name in the selected Docker context without inventing a host URI', async () => {
    const f = await fixture(false, true); await f.setup();
    await ensureNativeCaddyContainer({ ...f.input, containerName: 'configured-by-person' }, f.options());
    await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
    } } } });
    const before = f.commands.length;
    expect(await observeNativeCaddyContainer({}, { run: f.run })).toMatchObject({ status: 'ready', containerName: 'configured-by-person' });
    // A running private HTTP origin is not an observed HTTPS ingress capability.
    expect(await inspectCaddyFromCatalog(f.run)).toEqual({ kind: 'unknown', code: 'required_fact_unavailable' });
    expect(f.commands[before]!.args).toEqual(['container', 'ls', '--all', '--no-trunc', '--filter',
        'label=dev.happier.machine-setup.recipe=caddy@1', '--format', '{{json .ID}}']);
    expect(f.commands[before + 1]!.args).toEqual(['container', 'inspect', '--', 'owned-container-id']);
});

it('connects only missing observed Caddy networks through the same native writer as setup', async () => {
    const f = await fixture(); await f.setup();
    await ensureNativeCaddyContainer(f.input, f.options());
    const before = f.commands.length;
    expect(await connectNativeCaddyNetworks({ dockerHost: f.input.dockerHost, containerId: f.readContainer().Id,
        observedNetworkNames: Object.keys(f.readContainer().NetworkSettings.Networks), networkNames: ['routed-a', 'candidate-network', 'candidate-network'] },
    { run: f.run })).toEqual({ status: 'ready' });
    expect(Object.keys(f.readContainer().NetworkSettings.Networks)).toEqual(['routed-a', 'routed-b', 'candidate-network']);
    expect(f.commands.slice(before).map(command => command.args.slice(2))).toEqual([['network', 'connect', 'candidate-network', 'owned-container-id']]);
    expect(await connectNativeCaddyNetworks({ dockerHost: f.input.dockerHost, containerId: f.readContainer().Id,
        observedNetworkNames: [], networkNames: ['candidate-network'] }, { run: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }))
        .toEqual({ status: 'unavailable', reason: 'native_effect_failed' });
});

it('consumes the setup owner result and preserves the owned running container and autosave on another admission', async () => {
    const f = await fixture();
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toEqual({ status: 'needs_setup' });
    expect(f.commands.some(command => command.executable === 'docker')).toBe(false);
    await f.setup();
    const autosave = join(f.input.stateDirectory, 'config', 'caddy', 'autosave.json');
    await writeFile(autosave, '{"retainedDomain":"other-app.example"}');
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toEqual({ status: 'ready', containerId: 'owned-container-id' });
    const original = f.readContainer();
    expect(original.Config.Cmd).toEqual(['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json']);
    expect(original.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(original.HostConfig.Mounts.map(m => m.Target)).toEqual(['/data', '/config', '/var/log/happier-caddy', '/run/happier-caddy', '/etc/caddy/happier.json']);
    expect(original.HostConfig.PortBindings).toEqual({ '9381/tcp': [{ HostIp: '100.70.80.90', HostPort: '9381' }] });
    expect(Object.keys(original.NetworkSettings.Networks)).toEqual(['routed-a', 'routed-b']);
    // A draining incumbent's attachment belongs to P41, so another admission
    // must not disconnect it or rewrite the resumed config.
    original.NetworkSettings.Networks['incumbent-draining'] = {};
    const previous = f.commands.length;
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toEqual({ status: 'ready', containerId: original.Id });
    expect(f.readContainer()).toBe(original);
    expect(await readFile(autosave, 'utf8')).toBe('{"retainedDomain":"other-app.example"}');
    expect(f.commands.slice(previous).every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
    expect(readCaddyContainerFirewallExposures(f.input)).toEqual([f.input.privateBinding!.exposure]);
});

it('keeps no-network origins container-only and refuses a foreign or incompatible owned container without replacing it', async () => {
    const f = await fixture(false); await f.setup();
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toMatchObject({ status: 'ready' });
    expect(f.readContainer().HostConfig.PortBindings).toEqual({});
    expect(readCaddyContainerFirewallExposures(f.input)).toEqual([]);
    const before = f.commands.length;
    f.readContainer().Config.Labels = {};
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toEqual({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect(f.commands.slice(before).every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});

it.skipIf(process.platform === 'win32')('adds admitted public listeners and publications to the retained owned private-only Caddy without losing routes or networks', async () => {
    const f = await fixture(false, true); await f.setup();
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toMatchObject({ status: 'ready' });
    await f.closeAdmin();
    f.readContainer().NetworkSettings.Networks['incumbent-draining'] = {};
    const foreign = { '@id': 'another-domain', handle: [{ handler: 'static_response', status_code: 204 }] };
    const config = { admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: {
        http: { servers: { private: { listen: [':9381'], automatic_https: { disable: true }, routes: [foreign] } } },
    } };
    await mkdir(f.input.adminDirectory, { recursive: true });
    await writeFile(join(f.input.stateDirectory, 'initial.json'), JSON.stringify(config));
    const writes: string[] = [];
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Etag', '"retained"');
        if (request.method === 'GET') { response.end(JSON.stringify(config)); return; }
        expect(request.method).toBe('PUT');
        writes.push(request.url!);
        let body = ''; for await (const chunk of request) body += String(chunk);
        const path = request.url!.slice('/config/'.length).split('/').filter(Boolean).map(decodeURIComponent);
        let parent: object = config;
        for (const key of path.slice(0, -1)) parent = Reflect.get(parent, key);
        Reflect.set(parent, path.at(-1)!, JSON.parse(body));
        response.end('{}');
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(f.input.adminDirectory, 'admin.sock'), resolve); });
    servers.push(server);
    const publicBindings = [{ requirementId: 'https', exposure: 'public' as const, hostAddress: '0.0.0.0',
        hostPort: 443, containerPort: 443, protocol: 'tcp' as const }];
    const desired = { ...config, apps: { ...config.apps, http: { servers: { ...config.apps.http.servers,
        public: { listen: [':443'], tls_connection_policies: [{}], routes: [] } } },
        tls: { automation: { policies: [] }, certificates: { load_pem: [] } } } };
    const input = { ...f.input, publicBindings, initialConfig: JSON.stringify(desired) };
    let firewallSettlements = 0;
    const options = { ...f.options(), settleBindings: async () => { firewallSettlements++; } };
    expect(await ensureNativeCaddyContainer(input, options)).toMatchObject({ status: 'ready' });
    expect(f.readContainer().HostConfig.PortBindings).toEqual({ '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }] });
    expect(Object.keys(f.readContainer().NetworkSettings.Networks)).toContain('incumbent-draining');
    expect(config.apps.http.servers.private.routes).toEqual([foreign]);
    expect(await observeNativeCaddyContainer(input, { run: f.run })).toMatchObject({ status: 'ready', servers: expect.arrayContaining([
        expect.objectContaining({ serverId: 'public', tls: true, endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] }),
    ]) });
    const effects = f.commands.filter(command => ['stop', 'rm', 'create', 'start'].includes(command.args[3] ?? '')).length;
    expect(await ensureNativeCaddyContainer(input, options)).toMatchObject({ status: 'ready' });
    expect(f.commands.filter(command => ['stop', 'rm', 'create', 'start'].includes(command.args[3] ?? ''))).toHaveLength(effects);
    expect(writes).toEqual(['/config/apps/tls', '/config/apps/http/servers/public']);
    expect(firewallSettlements).toBe(2);
});

it('settles bindings after ownership validation and before creating or starting Caddy', async () => {
    const f = await fixture(); await f.setup();
    const effects: number[] = [];
    const options = { ...f.options(), settleBindings: async () => {
        effects.push(f.commands.filter(command => ['create', 'start', 'connect'].includes(command.args[3] ?? '')).length);
    } };
    expect(await ensureNativeCaddyContainer(f.input, options)).toMatchObject({ status: 'ready' });
    expect(effects).toEqual([0]);
    f.readContainer().State.Running = false;
    f.readContainer().Config.Labels = {};
    expect(await ensureNativeCaddyContainer(f.input, options)).toEqual({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect(effects).toEqual([0]);
});

it('does not retry an unknown Docker create outcome; the next admission adopts the exact owned container', async () => {
    const f = await fixture(); await f.setup(); f.loseCreate();
    await expect(ensureNativeCaddyContainer(f.input, f.options())).rejects.toThrow('lost Docker response');
    expect(f.commands.filter(command => command.args[3] === 'create')).toHaveLength(1);
    expect(await ensureNativeCaddyContainer(f.input, f.options())).toMatchObject({ status: 'ready' });
    expect(f.commands.filter(command => command.args[3] === 'create')).toHaveLength(1);
});

it('refuses unenforceable private exposure and propagates cancellation before a native effect', async () => {
    const f = await fixture(); await f.setup();
    expect(await ensureNativeCaddyContainer({ ...f.input, privateBinding: { ...f.input.privateBinding!, interfaceName: '' } }, f.options()))
        .toEqual({ status: 'unavailable', reason: 'private_scope_unenforceable' });
    expect(f.commands.some(command => command.executable === 'docker')).toBe(false);
    const abort = new AbortController(); abort.abort();
    await expect(ensureNativeCaddyContainer(f.input, { ...f.options(), signal: abort.signal })).rejects.toThrow();
});

it('publishes the selected IPv6 address literally and restores a stopped owned container without recreating it', async () => {
    const f = await fixture(); await f.setup();
    const input = { ...f.input, privateBinding: { ...f.input.privateBinding!, exposure: { ...f.input.privateBinding!.exposure, hostAddress: 'fd7a:115c:a1e0::42' } } };
    expect(await ensureNativeCaddyContainer(input, f.options())).toMatchObject({ status: 'ready' });
    expect(f.readContainer().HostConfig.PortBindings).toEqual({ '9381/tcp': [{ HostIp: 'fd7a:115c:a1e0::42', HostPort: '9381' }] });
    f.readContainer().State.Running = false;
    expect(await ensureNativeCaddyContainer(input, f.options())).toMatchObject({ status: 'ready' });
    expect(f.commands.filter(command => command.args[3] === 'create')).toHaveLength(1);
    expect(f.readContainer().State.Running).toBe(true);
});

it('publishes only explicit public edge bindings and exposes them through the same firewall declaration', async () => {
    const f = await fixture(false); await f.setup();
    const input = { ...f.input, publicBindings: [{ requirementId: 'edge-https', exposure: 'public' as const,
        hostAddress: '203.0.113.7', hostPort: 8443, containerPort: 443, protocol: 'tcp' as const }] };
    expect(await ensureNativeCaddyContainer(input, f.options())).toMatchObject({ status: 'ready' });
    expect(f.readContainer().HostConfig.PortBindings).toEqual({ '443/tcp': [{ HostIp: '203.0.113.7', HostPort: '8443' }] });
    expect(readCaddyContainerFirewallExposures(input)).toEqual(input.publicBindings);
});

it.each([
    { hostPort: 8443, containerPort: 9381 },
    { hostPort: 9381 },
])('refuses a public binding to the private origin before Docker access: %j', async binding => {
    const f = await fixture(false); await f.setup();
    const input = { ...f.input, publicBindings: [{ requirementId: 'public-origin', exposure: 'public' as const,
        hostAddress: '203.0.113.7', protocol: 'tcp' as const, ...binding }] };
    expect(await ensureNativeCaddyContainer(input, f.options())).toEqual({ status: 'unavailable', reason: 'private_scope_unenforceable' });
    expect(f.commands).toEqual([]);
});

it('treats a failed Docker observation as unavailable rather than absent', async () => {
    const f = await fixture(false); await f.setup();
    const reads: MachineSetupNativeCommand[] = [];
    expect(await ensureNativeCaddyContainer(f.input, { ...f.options(), run: async command => {
        reads.push(command);
        return { code: 1, stdout: '', stderr: 'Docker access denied' };
    } })).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable', details: {
        failure: { requiredFact: 'caddyContainer' },
    } });
    expect(reads.every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});
