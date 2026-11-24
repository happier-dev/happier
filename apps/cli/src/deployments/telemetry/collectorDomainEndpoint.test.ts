import { expect, it, vi } from 'vitest';
import * as deploymentProtocol from '@happier-dev/plugin-sdk/protocol';
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
        installationId: 'host-installation', deploymentId: 'collector-deployment',
        app: { environmentId: 'collector-environment', serviceName: 'collector', port: 4318 } });
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
    const sendChild = vi.fn(async () => topology);
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', collectorMachineId: 'collector',
        observerNetworks: [{ ...network, addresses: ['100.70.0.3'] }],
        async list() { return { ok: true as const, environmentId: 'environment', revision: 1, domains: [header()], nextCursor: null }; },
        async open(): Promise<DeploymentArtifactDocumentV1> { return { artifactId: reference.contentArtifactId,
            header: { kind: 'deployment-domain.v1', title: 'Collector' }, body: JSON.stringify({ hostname: 'collector.example.test', target }),
            revision: { headerVersion: 1, bodyVersion: 1 } }; },
        // The signed native RPC is the network boundary; Domain selection and
        // private-network matching beneath it use their real owners.
        deployment: { id: 'accepted-deploy', actionOperationId: 'accepted-operation' }, sendChild,
    };
    expect(await readTelemetryCollectorDomainForHost(input)).toEqual({ kind: 'ready', endpoint: 'http://100.70.0.2:8080' });
    expect(sendChild).toHaveBeenCalledExactlyOnceWith({
        v: 1, kind: 'domain', actionId: 'deployments.domains.verify', machineId: 'collector', installationId: 'installed',
        input: { serverId: 'home', environmentId: 'environment', domainId: 'domain' },
        expectedDomainRevision: 1, capture: header().placements![0],
        observeTopology: { environmentId: 'environment', deploymentId: 'accepted-deploy', actionOperationId: 'accepted-operation' },
    });
    sendChild.mockClear();
    target = { service: 'web', containerPort: 80 };
    expect(await readTelemetryCollectorDomainForHost(input)).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable' });
    target = { kind: 'telemetry' }; selectedMachine = 'another-machine';
    expect(await readTelemetryCollectorDomainForHost(input)).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable' });
    expect(sendChild).not.toHaveBeenCalled();
    selectedMachine = 'collector';
    expect(await readTelemetryCollectorDomainForHost({ ...input, sendChild: async () => ({ ok: true }) }))
        .toEqual({ kind: 'unavailable', reason: 'collector_route_unavailable' });
    expect(await readTelemetryCollectorDomainForHost({ ...input, sendChild: async () => ({
        ok: false, errorCode: 'target_mismatch', error: 'target_mismatch',
    }) })).toEqual({ kind: 'unavailable', reason: 'target_mismatch' });
    expect(await readTelemetryCollectorDomainForHost({ ...input, observerNetworks: [{ ...network, networkIdentity: 'unrelated' }] }))
        .toMatchObject({ kind: 'unavailable', reason: 'private_scope_unenforceable' });
    expect(await readTelemetryCollectorDomainForHost({ ...input, sendChild: async () => ({ ...topology, machineId: 'substituted' }) }))
        .toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
});

it.each(['save', 'picker'] as const)('%s uses only the settled public HTTPS route for the selected Domain, collector deployment and installation', async surface => {
    const reference = { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const controller = { machineId: 'collector-host', installationId: 'collector-installation' };
    const collector = { machineId: 'collector-child', deploymentId: 'collector-deployment' };
    const origin = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment',
        targetLinkId: 'link', domainId: 'selected-domain', ...controller, actionOperationId: 'domain-operation',
        requestId: 'domain-request', nativeServer: 'private' }, content: reference,
        desired: true, listener: 'privateOrigin' as const, telemetryCollector: collector };
    const edge = { ...origin, placement: { ...origin.placement, machineId: 'edge', installationId: 'edge-installation',
        nativeServer: 'https' }, listener: 'public' as const };
    const base = { v: 1 as const, id: 'selected-domain', environmentId: 'environment', targetLinkId: 'link',
        revision: 1, state: 'active' as const, ...reference, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
        placements: [origin, edge] };
    let domain: unknown = base;
    let target: unknown = { kind: 'telemetry' };
    let preparation: unknown;
    const input = { kind: 'publicHttps' as const, serverId: 'home', environmentId: 'environment', targetLinkId: 'link',
        domainId: 'selected-domain', collector: { ...collector, controller },
        async get(query: { serverId: string; environmentId: string; domainId: string }) {
            expect(query).toEqual({ serverId: 'home', environmentId: 'environment', domainId: 'selected-domain' });
            if (!domain) return { ok: false as const, error: 'deployment_unavailable' as const };
            return { ok: true as const, domain: DeploymentDomainHeaderV1Schema.parse(domain),
                environmentId: 'environment', revision: 1 };
        },
        async open(): Promise<DeploymentArtifactDocumentV1> { return { artifactId: reference.contentArtifactId,
            header: { kind: 'deployment-domain.v1', title: 'Collector' },
            body: JSON.stringify({ hostname: 'collector.example.test', target, cloudflarePreparation: preparation }),
            revision: { headerVersion: 1, bodyVersion: 1 } }; },
    };
    const resolve = () => surface === 'save' ? readTelemetryCollectorDomainForHost(input)
        : deploymentProtocol.selectPublicTelemetryCollectorDomainV1({ ...input, domain: domain ? DeploymentDomainHeaderV1Schema.parse(domain) : null });
    expect(await resolve()).toEqual({ kind: 'ready', endpoint: 'https://collector.example.test/' });
    domain = { ...base, state: 'pending' };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable', state: 'pending' });
    domain = { ...base, id: 'another-domain' };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
    domain = { ...base, placements: [{ ...origin, telemetryCollector: { ...collector, deploymentId: 'preceding-deployment' } }, edge] };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
    domain = { ...base, placements: [{ ...origin, placement: { ...origin.placement, installationId: 'retired' } }, edge] };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
    domain = { ...base, placements: [{ ...origin, telemetryCollector: undefined }, edge] };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable', state: 'unbound' });
    domain = { ...base, placements: [origin] };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'collector_route_unavailable', state: 'private_only' });
    preparation = { tunnelId: 'admitted-tunnel', owned: [{ hostname: 'collector.example.test', expectedService: 'http://caddy:8080' }],
        dnsOwnership: [{ hostname: 'collector.example.test', recordId: 'dns-record' }],
        connectors: [{ ...controller, imageRef: 'cloudflared', version: '1', networkName: 'native', grantRef: 'connector-grant' }] };
    expect(await resolve()).toEqual({ kind: 'ready', endpoint: 'https://collector.example.test/' });
    domain = base;
    target = { kind: 'native', service: 'unrelated', containerPort: 4318 };
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'target_mismatch' });
    domain = null;
    expect(await resolve()).toMatchObject({ kind: 'unavailable', reason: 'deployment_unavailable' });
    const denied = { ok: false as const, errorCode: 'deployment_access_denied', error: 'deployment_access_denied',
        details: { requiredFact: 'source_admission' } };
    expect(await readTelemetryCollectorDomainForHost({ ...input, get: async () => denied })).toEqual({
        kind: 'unavailable', reason: denied.errorCode, failure: denied,
    });
});
