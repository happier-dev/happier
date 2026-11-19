import { expect, it } from 'vitest';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainMachineTopologyV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { readTelemetryCollectorDomainForHost, readTelemetryCollectorPlacementForHost } from '../targets/ownServer/domainRouteSelection';

it('places a deployed collector on its accepted native host and consumes its private service binding', () => {
    const machine = { id: 'collector-child', installationId: 'child-installation',
        deploymentApp: { environmentId: 'collector-environment', deploymentId: 'collector-deployment', targetLinkId: 'collector-link',
            controller: { machineId: 'collector-host', installationId: 'host-installation' } },
        metadata: { deploymentApp: { serviceName: 'collector', port: 4318 } } };
    expect(readTelemetryCollectorPlacementForHost(machine)).toEqual({ kind: 'ready', machineId: 'collector-host',
        installationId: 'host-installation', app: { environmentId: 'collector-environment', serviceName: 'collector', port: 4318 } });
    expect(readTelemetryCollectorPlacementForHost({ ...machine, metadata: null })).toEqual({ kind: 'unavailable',
        reason: 'machine_content_key_unavailable' });
    expect(readTelemetryCollectorPlacementForHost({ ...machine, metadata: {} })).toEqual({ kind: 'unavailable',
        reason: 'collector_route_unavailable' });
    expect(readTelemetryCollectorPlacementForHost({ ...machine, deploymentApp: null })).toEqual({ kind: 'ready',
        machineId: 'collector-child', installationId: 'child-installation' });
});

it('resolves only the selected collector Domain over its actual shared privateOrigin, with no public or unrelated route fallback', async () => {
    const network: MachinePrivateNetworkObservationV1 = { provider: { kind: 'builtin', id: 'tailscale' },
        networkIdentity: 'tailnet', interfaceName: 'tailscale0', state: 'ready', addresses: ['100.70.0.2'],
        sourceRanges: ['100.64.0.0/10'], displayName: null, dnsName: null, magicDnsEnabled: false };
    const reference = { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    let target: unknown = { kind: 'telemetry' };
    let selectedMachine = 'collector';
    const header = () => DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: 'environment',
        targetLinkId: 'link', revision: 1, state: 'active', ...reference, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
        placements: [{ placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: selectedMachine, installationId: 'installed', actionOperationId: 'domain-operation',
            requestId: 'domain-request', nativeServer: 'private' }, content: reference, desired: true, listener: 'privateOrigin', dockerEngineId: 'native' }] });
    const topology = DeploymentDomainMachineTopologyV1Schema.parse({ machineId: 'collector', installationId: 'installed',
        dockerEngineId: 'native', privateNetworks: [network], replicas: [], caddy: { status: 'ready', containerId: 'caddy',
            containerName: 'happier-caddy', adminSocketPath: '/run/caddy/admin.sock', networkNames: ['bridge'],
            servers: [{ serverId: 'private', listen: [':8080'], tls: false, automaticHttpsDisabled: true,
                endpoints: [{ hostAddress: network.addresses[0], hostPort: 8080, containerPort: 8080 }] }],
            privateOrigins: [{ serverId: 'private', endpoint: '100.70.0.2:8080', network }] } });
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', collectorMachineId: 'collector',
        observerNetworks: [{ ...network, addresses: ['100.70.0.3'] }],
        async list() { return { ok: true as const, environmentId: 'environment', revision: 1, domains: [header()], nextCursor: null }; },
        async open(): Promise<DeploymentArtifactDocumentV1> { return { artifactId: reference.contentArtifactId,
            header: { kind: 'deployment-domain.v1', title: 'Collector' }, body: JSON.stringify({ hostname: 'collector.example.test', target }),
            revision: { headerVersion: 1, bodyVersion: 1 } }; },
        // The signed native RPC is the network boundary; Domain selection and
        // private-network matching beneath it use their real owners.
        async observe() { return topology; },
    };
    expect(await readTelemetryCollectorDomainForHost(input)).toEqual({ kind: 'ready', endpoint: 'http://100.70.0.2:8080' });
    target = { service: 'web', containerPort: 80 };
    expect(await readTelemetryCollectorDomainForHost(input)).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable' });
    target = { kind: 'telemetry' }; selectedMachine = 'another-machine';
    expect(await readTelemetryCollectorDomainForHost(input)).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable' });
    selectedMachine = 'collector';
    expect(await readTelemetryCollectorDomainForHost({ ...input, observerNetworks: [{ ...network, networkIdentity: 'unrelated' }] }))
        .toMatchObject({ kind: 'unavailable', reason: 'private_scope_unenforceable' });
    expect(await readTelemetryCollectorDomainForHost({ ...input, observe: async () => ({ ...topology, machineId: 'substituted' }) }))
        .toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
});
