import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { createDeploymentTelemetryHost } from './collectorHost';
import { materializeCaddyDomainRouteV1 } from '../targets/ownServer/caddyRouteMaterialization';

import { createRelayDockerFixture, readRelayHttpBody } from '../targets/ownServer/privateServiceContainerBridge.testkit';

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
    const fixture = createRelayDockerFixture('collector-network-id', 'collector-network');
    const { docker } = fixture;
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
    const readEndpoint = () => readRelayHttpBody(fixture.socketPath(bridge.host));
    const firstSocket = fixture.socketPath(bridge.host);
    expect(await readEndpoint()).toBe('first receiver');
    const material = materializeCaddyDomainRouteV1({ domainId: 'collector-domain', domain, listener: 'privateOrigin',
        privateSourceRanges: ['127.0.0.0/8'], upstreams: { kind: 'privateOrigins', endpoints: [`${bridge.host}:${bridge.port}`] },
        telemetryBridgeNetworkId: bridge.networkId });
    configuration = { apps: { http: { servers: { private: { routes: [material.route] } } } } };
    withdraw();
    await first.closeDomainEndpoints();
    await expect(readRelayHttpBody(firstSocket)).rejects.toThrow();
    first.bind(firstLifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
    await first.restoreDomainEndpoints();
    expect(await readEndpoint()).toBe('first receiver');
    firstLifetime.abort();
    await first.closeDomainEndpoints();
    body = 'receiver after restart';
    const secondLifetime = new AbortController();
    context.onTestFinished(() => secondLifetime.abort());
    const second = createDeploymentTelemetryHost(options);
    second.bind(secondLifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
    await second.restoreDomainEndpoints();
    const reacquired = await second.acquireDomainEndpoint({ docker, engine: { id: 'local', kind: 'native' }, networkId: 'collector-network' });
    expect(reacquired.host).toBe(bridge.host);
    expect(reacquired.port).toBe(bridge.port);
    expect(await readEndpoint()).toBe('receiver after restart');
    expect(failures).toEqual([]);
    await second.closeDomainEndpoints();
});
