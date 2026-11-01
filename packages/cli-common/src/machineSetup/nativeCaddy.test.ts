import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { DeploymentDomainMachineTopologyV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import { ensureNativeCaddyContainer, nativeCaddyImage, readCaddyContainerFirewallExposures, observeNativeCaddyContainer, createNativeCaddyBindings, connectNativeCaddyNetworks, hashNativeCaddyPassword, type NativeCaddySetupInput } from './nativeCaddy.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };

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

async function fixture(privateNetwork = true, socketFixture = false) {
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
        if (args[0] === 'container' && args[1] === 'start') { container!.State.Running = true; return ok(container!.Id); }
        throw new Error(`Unexpected Docker operation: ${args[0]} ${args[1]}`);
    };
    const backend = createMachineSetupNativeBackend({ run });
    const unapproved = await checkMachineSetupEffectPlan({ basis, steps: [], backend });
    let setupResult = await applyMachineSetupEffectPlan({ plan: { ...unapproved, planDigest: 'b'.repeat(64) }, backend });
    const setup = async () => {
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [], backend });
        setupResult = await applyMachineSetupEffectPlan({ plan, backend });
        expect(setupResult).toMatchObject({ status: 'applied' });
    };
    const serveAdmin = async (config: unknown) => {
        await mkdir(input.adminDirectory, { recursive: true });
        await writeFile(join(input.stateDirectory, 'initial.json'), input.initialConfig);
        let reads = 0;
        const server = createServer((request, response) => {
            expect(request.url).toBe('/config/');
            expect(request.method).toBe('GET');
            reads++;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(config));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(join(input.adminDirectory, 'admin.sock'), resolve);
        });
        servers.push(server);
        return { reads: () => reads };
    };
    return { input, commands, run, setup, serveAdmin, options: () => ({ run, setupResult }), readContainer: () => container!, loseCreate: () => { loseCreateResponse = true; } };
}

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
    await f.setup(); await ensureNativeCaddyContainer(f.input, f.options());
    const before = f.commands.length;
    f.readContainer().State.Running = false;
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'stopped', containerId: 'owned-container-id' });
    f.readContainer().Config.Labels = {};
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect(await observeNativeCaddyContainer(f.input, { run: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }))
        .toEqual({ status: 'unavailable', reason: 'required_fact_unavailable' });
    expect(f.commands.slice(before).every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});

it.skipIf(process.platform === 'win32')('refuses an unreachable or changed admin socket without treating the mounted seed as live evidence', async () => {
    const f = await fixture(true, true); await f.setup();
    await ensureNativeCaddyContainer(f.input, f.options());
    await writeFile(join(f.input.stateDirectory, 'initial.json'), f.input.initialConfig);
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'required_fact_unavailable' });
    await f.serveAdmin({ admin: { listen: 'localhost:2019' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
    } } } });
    expect(await observeNativeCaddyContainer(f.input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'required_fact_unavailable' });
});

it.skipIf(process.platform === 'win32')('discovers the actual owned Caddy name in the selected Docker context without inventing a host URI', async () => {
    const f = await fixture(false, true); await f.setup();
    await ensureNativeCaddyContainer({ ...f.input, containerName: 'configured-by-person' }, f.options());
    await f.serveAdmin({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' }, apps: { http: { servers: {
        local: { listen: [':9381'], automatic_https: { disable: true } },
    } } } });
    const before = f.commands.length;
    expect(await observeNativeCaddyContainer({}, { run: f.run })).toMatchObject({ status: 'ready', containerName: 'configured-by-person' });
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
    } })).toEqual({ status: 'unavailable', reason: 'required_fact_unavailable' });
    expect(reads.every(command => command.args[3] === 'ls' || command.args[3] === 'inspect')).toBe(true);
});
