import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { machineSetup } from '@happier-dev/cli-common';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { createNativeCaddyRoutes } from '@/machines/reachability/nativeCaddyRoutes';

const environment: DeploymentEnvironmentContentV1 = { name: 'Staging', retainPreviousDeployments: 1, bindings: [],
    definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } } };

it('assembles the Machine Caddy origin independently of the unpublished workload port', async () => {
    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Domain setup must borrow the already acquired service facts'); } });
    const prepared = runtime.prepareDomainCaddy!({
        domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment: { ...environment, ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: [{ key: 'web', service: 'web', containerPort: 80,
            scheme: 'http', exposure: 'privateNetwork', privateNetwork: 'tailnet-a' }] } },
        replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [{ provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'tailnet-a',
            displayName: null, dnsName: null, state: 'ready', addresses: ['100.70.80.90'],
            interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: null },
            { provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'tailnet-b',
                displayName: null, dnsName: null, state: 'ready', addresses: ['100.70.80.91'],
                interfaceName: 'tailscale1', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: null }],
        daemonGroup: 'happier', daemonGroupId: 1001,
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error('Caddy profile unavailable');
    expect(prepared.input).toMatchObject({ containerName: 'happier-caddy', originPort: 8080,
        routedNetworks: ['deployed_default'], publicBindings: [], privateBinding: {
            interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], exposure: {
                hostAddress: '100.70.80.90', hostPort: 8080, containerPort: 8080, exposure: 'privateNetwork' } } });
    const seed = JSON.parse(prepared.input.initialConfig);
    const [nativeServer, server] = Object.entries(seed.apps.http.servers)[0]!;
    const routes = createNativeCaddyRoutes({ machineId: 'machine', installationId: 'installation',
        privateKey: new Uint8Array(64), async exchange() { return { status: 200, value: structuredClone(server), etag: 'seed' }; } });
    expect(await routes.observe({ placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment',
        targetLinkId: 'link', domainId: 'domain', machineId: 'machine', installationId: 'installation',
        actionOperationId: 'operation', requestId: 'request', nativeServer },
        route: { domainId: 'domain', domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 },
            healthCheck: { path: '/healthz', expectStatus: 200 } },
            listener: 'privateOrigin' } })).toEqual({ kind: 'absent' });
    expect(JSON.parse(prepared.input.initialConfig)).toEqual({
        admin: { listen: 'unix//run/happier-caddy/admin.sock|0660', config: { persist: true } },
        apps: { http: { servers: { happier_private: { listen: [':8080'], automatic_https: { disable: true },
            routes: [{ handle: [{ handler: 'static_response', status_code: 404 }], terminal: true }], errors: { routes: [] } } } } },
    });
    expect(prepared.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'directory', path: '/var/lib/happier/caddy/data' }),
        expect.objectContaining({ kind: 'directory', path: '/var/lib/happier/caddy/config' }),
        expect.objectContaining({ kind: 'directory', path: '/run/happier-caddy', group: 'happier', mode: 0o750 }),
        expect.objectContaining({ kind: 'file', path: '/var/lib/happier/caddy/initial.json' }),
    ]));
    const containerOnly = runtime.prepareDomainCaddy!({ domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment: environment, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1001 });
    expect(containerOnly).toMatchObject({ status: 'ready', input: { originPort: 8080, publicBindings: [] } });
    if (containerOnly.status === 'ready') expect(containerOnly.input.privateBinding).toBeUndefined();
    const offlinePrivate = runtime.prepareDomainCaddy!({ domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment: { ...environment, ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: [{ key: 'web', service: 'web', containerPort: 80,
            scheme: 'http', exposure: 'privateNetwork', privateNetwork: 'tailnet-a' }] } },
        replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1001 });
    expect(offlinePrivate).toMatchObject({ status: 'ready', input: { originPort: 8080, publicBindings: [] } });
    if (offlinePrivate.status === 'ready') expect(offlinePrivate.input.privateBinding).toBeUndefined();

});

it('prepares Caddy without ingress and preserves the Admin Access None refusal before native effects', async () => {
    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses the deployed service facts'); } });
    const prepared = runtime.prepareDomainCaddy!({
        domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1001,
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') throw new Error('No ingress is required for the native Caddy origin');
    let nativeEffects = 0;
    await expect(prepared.ensure({
        setup: {
            readDesired: () => getMachineSetupDesiredV1({
                read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
                compareAndSwap: async () => { throw new Error('Setup discovery cannot change desired policy'); },
            }),
            elevation: {
                readPolicy: async () => ({ version: 1, mode: 'none' }),
                observe: async () => { throw new Error('None refuses before native privilege observation'); },
                spawn: () => { nativeEffects++; throw new Error('None cannot elevate'); },
            },
        },
        context: { actionRequestId: 'no-ingress-admin-none' }, actionId: 'deployments.domains.add',
        installationId: 'installation', dockerEngineId: 'engine', signal: new AbortController().signal,
        async run() { nativeEffects++; throw new Error('None cannot mutate Docker'); },
    })).rejects.toMatchObject({ code: 'mode_none' });
    expect(nativeEffects).toBe(0);
});


it.each(['preauthorized', 'ask'] as const)('runs the canonical Caddy setup and native container leaf with %s administrator access', async mode => {
    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: `machine-${mode}`,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses deployed service facts'); } });
    const prepared = runtime.prepareDomainCaddy!({
        domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1001,
    });
    if (prepared.status !== 'ready') throw new Error('Expected the container Caddy leaf');
    let prompts = 0;
    const failures: unknown[] = [];
    const dockerCommands: string[][] = [];
    // Sudo streams and native filesystem state are OS boundaries. Both setup
    // interpreters, plan matching, admission and Caddy container effects are real.
    const backend: machineSetup.MachineSetupBackend = {
        async observe(step) { return { stepId: step.id, status: 'satisfied', facts: { installed: true } }; },
        async apply() { throw new Error('The native setup directories are already satisfied'); },
    };
    const spawn: MachineElevationSpawn = () => {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        const settled = (async () => {
            const lines = createInterface({ input: stdin });
            const frames = lines[Symbol.asyncIterator]();
            try {
                if (mode === 'ask') {
                    stderr.write('[happier-sudo-password:operator]\n');
                    const password = await frames.next();
                    expect(password.value).toBe('one-use-password');
                }
                stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
                const frame = await frames.next();
                const request = MachineEffectInternalRequestSchema.parse(JSON.parse(frame.value!));
                if (request.mode !== 'check' || !('steps' in request)) throw new Error('Expected setup CHECK');
                const plan = await machineSetup.checkMachineSetupEffectPlan({ basis: request.basis, steps: request.steps, backend });
                stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
                const next = await frames.next();
                const apply = MachineEffectInternalRequestSchema.parse(JSON.parse(next.value!));
                if (apply.mode !== 'apply' || !('plans' in apply)) throw new Error('Expected setup APPLY');
                const result = await machineSetup.applyMachineSetupEffectPlans({ plans: apply.plans, backend });
                stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
                return { code: 0, signal: null };
            } catch (error) { failures.push(error); return { code: 1, signal: null }; }
            finally { lines.close(); stdout.end(); stderr.end(); }
        })();
        return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const result = await prepared.ensure({
        setup: { readDesired: () => getMachineSetupDesiredV1({
            read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
            compareAndSwap: async () => { throw new Error('Discovery cannot change desired policy'); },
        }), elevation: {
            readPolicy: async () => mode === 'ask' ? { version: 1, mode, administratorUsername: 'operator' } : { version: 1, mode },
            observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier',
                daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
                managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
            prompt: async () => { prompts++; return { password: 'one-use-password' }; }, spawn,
        } },
        context: { actionRequestId: `domain-${mode}` }, actionId: 'deployments.domains.add',
        installationId: 'installation', dockerEngineId: `engine-${mode}`, signal: new AbortController().signal,
        async run(command) {
            dockerCommands.push([...command.args]);
            if (command.args[0] === 'container' && command.args[1] === 'ls') return { code: 0, stdout: '', stderr: '' };
            if (command.args[0] === 'container' && command.args[1] === 'create') return { code: 0, stdout: 'owned-caddy', stderr: '' };
            if (command.args[0] === 'container' && command.args[1] === 'start') return { code: 0, stdout: 'owned-caddy', stderr: '' };
            throw new Error('Unexpected Docker command');
        },
    });
    expect(failures).toEqual([]);
    expect(result).toEqual({ status: 'ready', containerId: 'owned-caddy' });
    expect(prompts).toBe(mode === 'ask' ? 1 : 0);
    expect(dockerCommands.find(args => args[1] === 'create')).toEqual(expect.arrayContaining([
        '--restart', 'unless-stopped', 'caddy', 'run', '--resume',
    ]));
    expect(dockerCommands.flat()).not.toContain('--publish');
});


it('retains the managed CLI install recovery when preauthorization has no usable native executable', async () => {
    const installHome = await mkdtemp(join(tmpdir(), 'domain-caddy-no-cli-'));
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', installHome);
    onTestFinished(async () => { vi.unstubAllEnvs(); await rm(installHome, { recursive: true, force: true }); });
    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-missing-cli',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        async acquirePluginRuntimeRegistryLease() { throw new Error('Uses deployed service facts'); } });
    const prepared = runtime.prepareDomainCaddy!({
        domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 } },
        environment, replicas: [{ containerName: 'deployed-web-1', networkNames: ['deployed_default'] }],
        privateNetworks: [], daemonGroup: 'happier', daemonGroupId: 1001,
    });
    if (prepared.status !== 'ready') throw new Error('Expected the container Caddy leaf');
    await expect(prepared.ensure({
        setup: { readDesired: () => getMachineSetupDesiredV1({
            read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
            compareAndSwap: async () => { throw new Error('Discovery cannot change desired policy'); },
        }), elevation: {
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
            observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier',
                daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
                managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
        } },
        context: { actionRequestId: 'domain-missing-cli' }, actionId: 'deployments.domains.add',
        installationId: 'installation', dockerEngineId: 'engine-missing-cli', signal: new AbortController().signal,
        async run() { throw new Error('No Docker mutation without a usable native executable'); },
    })).rejects.toMatchObject({ code: 'managed_cli_unavailable', details: {
        recovery: { kind: 'install_managed_cli', executablePath: resolveInstalledMachineEffectCli() },
    } });
});
