import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { DeploymentDomainContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentTelemetryHost } from './collectorHost';
import { materializeCaddyDomainRouteV1 } from '../targets/ownServer/caddyRouteMaterialization';

it.skipIf(process.platform !== 'linux')('keeps a collector Domain reachable after its native job ends and reopens its installed upstream after a daemon restart', async context => {
    const domain = DeploymentDomainContentV1Schema.parse({ hostname: 'collector.example.test', target: { kind: 'telemetry' } });
    let body = 'first receiver';
    const receiver = createServer((_request, response) => response.end(body));
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    context.onTestFinished(() => new Promise<void>(resolve => receiver.close(() => resolve())));
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('Receiver unavailable');
    let configuration: unknown = { apps: { http: { servers: {} } } };
    const caddy = createServer((_request, response) => response.end(JSON.stringify(configuration)));
    caddy.listen(0, '127.0.0.1');
    await once(caddy, 'listening');
    context.onTestFinished(() => new Promise<void>(resolve => caddy.close(() => resolve())));
    const admin = caddy.address();
    if (!admin || typeof admin === 'string') throw new Error('Caddy admin unavailable');
    // Docker is the OS boundary. The real bridge inspects this network and
    // binds a real host-local socket; Caddy configuration crosses real HTTP.
    const docker = { engineId: 'local', engineKind: 'native' as const, async run(args: readonly string[]) {
        expect(args).toEqual(['network', 'inspect', 'collector-network']);
        return { exitCode: 0, stdout: JSON.stringify([{ Id: 'collector-network', Driver: 'bridge', Scope: 'local',
            IPAM: { Config: [{ Subnet: '127.0.0.0/8', Gateway: '127.0.0.1' }] } }]) };
    } };
    const failures: unknown[] = [];
    const options = { serverBaseUrl: 'https://home.test', token: 'fixture', machineId: 'collector',
        subscribeMachineChanges: () => () => {}, onRefreshError: (error: unknown) => { failures.push(error); },
        async readInstalledCollectorCaddy() { return { configuration: await (await fetch(`http://127.0.0.1:${admin.port}`)).json(),
            docker, engine: { id: 'local', kind: 'native' as const }, async release() {} }; },
    };
    const firstLifetime = new AbortController();
    context.onTestFinished(() => firstLifetime.abort());
    const first = createDeploymentTelemetryHost(options);
    const withdraw = first.bind(firstLifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
    const bridge = await first.acquireDomainEndpoint({ docker, engine: { id: 'local', kind: 'native' }, networkId: 'collector-network' });
    const endpoint = `http://${bridge.host}:${bridge.port}`;
    expect(await (await fetch(endpoint)).text()).toBe('first receiver');
    const material = materializeCaddyDomainRouteV1({ domainId: 'collector-domain', domain, listener: 'privateOrigin',
        privateSourceRanges: ['127.0.0.0/8'], upstreams: { kind: 'privateOrigins', endpoints: [`${bridge.host}:${bridge.port}`] },
        telemetryBridgeNetworkId: bridge.networkId });
    configuration = { apps: { http: { servers: { private: { routes: [material.route] } } } } };
    withdraw();
    await first.closeDomainEndpoints();
    await expect(fetch(endpoint)).rejects.toThrow();
    first.bind(firstLifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
    await first.restoreDomainEndpoints();
    expect(await (await fetch(endpoint)).text()).toBe('first receiver');
    firstLifetime.abort();
    await first.closeDomainEndpoints();
    body = 'receiver after restart';
    const secondLifetime = new AbortController();
    context.onTestFinished(() => secondLifetime.abort());
    const second = createDeploymentTelemetryHost(options);
    second.bind(secondLifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
    await second.restoreDomainEndpoints();
    expect(await (await fetch(endpoint)).text()).toBe('receiver after restart');
    expect(failures).toEqual([]);
    await second.closeDomainEndpoints();
});
