import type { NativeCaddyObservationResult } from '@happier-dev/cli-common/machineSetup';
import { accessProviderRefsEqualV1, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { DeploymentIngressV1, DeploymentDomainAddInputV1, DeploymentDomainHeaderV1,
    DeploymentDomainListInputV1, DeploymentDomainListResultV1Schema, DeploymentDomainTopologyV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { createNativeCaddyRoutes, NativeCaddyStartFirstLeg } from '@/machines/reachability/nativeCaddyRoutes';
import { caddyPublicHttpServerId, type CaddyDomainRouteInput } from './caddyRouteMaterialization';

export type DomainCaddyMemberObservation = Readonly<{
    machineId: string; state: 'active' | 'joining'; caddy: NativeCaddyObservationResult;
}>;
const activeDomainMembersDetails = { requiredFact: 'activeDomainMembers',
    remedy: 'Deploy the app so it is running on this Machine, then add the domain' } as const;
export type DomainRouteSelectionUnavailable = Readonly<{
    status: 'unavailable'; machineIds: readonly string[];
}> & (Readonly<{ reason: 'required_fact_unavailable'; details: Readonly<{ requiredFact: string; remedy?: string }> }>
    | Readonly<{ reason: 'private_scope_unenforceable'; details?: never }>);
type InstalledCaddyMember = DomainCaddyMemberObservation & Readonly<{ installationId: string; dockerEngineId: string }>;
type Placement = NonNullable<DeploymentDomainAddInputV1['placements']>[number];
export type DomainCaddyPlacementsSelection = Readonly<{ status: 'ready'; placements: readonly Placement[];
    tunnelOrigin?: NonNullable<DeploymentDomainTopologyV1['tunnelOrigin']> }>
    | DomainRouteSelectionUnavailable;

/** Derive native placement before admission from the observed listener roles.
 * A public HTTP redirect is not the private app listener. No new mode default
 * is chosen here for a multi-Machine Environment. */
export function selectDomainCaddyPlacements(input: Readonly<{
    ingress?: DeploymentIngressV1; members: readonly InstalledCaddyMember[];
    edge?: Readonly<{ machineId: string; installationId: string; dockerEngineId: string; caddy: NativeCaddyObservationResult }>;
}>): DomainCaddyPlacementsSelection {
    const members = input.members.filter(member => member.state === 'active');
    if (!members.length || !input.ingress && members.length > 1) return { status: 'unavailable',
        reason: 'required_fact_unavailable', machineIds: members.map(member => member.machineId),
        details: members.length ? { requiredFact: 'domainIngress' } : activeDomainMembersDetails };
    const placements: Placement[] = [];
    const tunnelMachineIds = input.ingress?.kind === 'cloudflareTunnel' ? members.map(member => member.machineId) : undefined;
    const tunnelMembers: Array<{ machineId: string; installationId: string; containerId: string; nativeServer: string;
        origins: NonNullable<Extract<NativeCaddyObservationResult, { status: 'ready' }>['containerOrigins']> }> = [];
    for (const member of members) {
        if (member.caddy.status !== 'ready') return { status: 'unavailable', reason: 'required_fact_unavailable',
            machineIds: tunnelMachineIds ?? [member.machineId], details: { requiredFact: 'memberCaddyObservation' } };
        const redirects = new Set(member.caddy.servers.filter(server => server.tls).map(server => caddyPublicHttpServerId(server.serverId)));
        const origins = member.caddy.servers.filter(server => !server.tls && server.automaticHttpsDisabled && !redirects.has(server.serverId));
        if (origins.length !== 1) return { status: 'unavailable', reason: 'required_fact_unavailable',
            machineIds: tunnelMachineIds ?? [member.machineId], details: { requiredFact: 'privateCaddyListener' } };
        const nativeServer = origins[0]!.serverId;
        placements.push({ machineId: member.machineId, installationId: member.installationId, dockerEngineId: member.dockerEngineId,
            nativeServer, listener: 'privateOrigin' });
        if (tunnelMachineIds) tunnelMembers.push({ machineId: member.machineId, installationId: member.installationId,
            containerId: member.caddy.containerId, nativeServer,
            origins: (member.caddy.containerOrigins ?? []).filter(origin => origin.serverId === nativeServer) });
    }
    let tunnelOrigin: NonNullable<DeploymentDomainTopologyV1['tunnelOrigin']> | undefined;
    if (tunnelMachineIds) {
        for (const candidate of tunnelMembers[0]?.origins ?? []) {
            const selected = tunnelMembers.flatMap(member => {
                const origin = member.origins.find(origin => origin.service === candidate.service);
                return origin ? [{ machineId: member.machineId, installationId: member.installationId,
                    containerId: member.containerId, networkName: origin.networkName, nativeServer: member.nativeServer }] : [];
            });
            if (selected.length === members.length) {
                tunnelOrigin = { service: candidate.service, members: selected };
                break;
            }
        }
        if (!tunnelOrigin) return { status: 'unavailable', reason: 'required_fact_unavailable', machineIds: tunnelMachineIds,
            details: { requiredFact: 'sharedTunnelOrigin' } };
    }
    let publicHost: Readonly<{ machineId: string; installationId: string; dockerEngineId: string; caddy: NativeCaddyObservationResult }> | undefined;
    if (input.ingress?.kind === 'edgeCaddy') {
        const edgeMachineId = input.ingress.edgeMachineId;
        publicHost = input.edge?.machineId === edgeMachineId ? input.edge : members.find(member => member.machineId === edgeMachineId);
    } else if (input.ingress === undefined) publicHost = members[0];
    if (input.ingress?.kind === 'edgeCaddy' && !publicHost) return { status: 'unavailable', reason: 'required_fact_unavailable',
        machineIds: [input.ingress.edgeMachineId], details: { requiredFact: 'edgeCaddyMachine' } };
    if (publicHost) {
        if (publicHost.caddy.status !== 'ready') return { status: 'unavailable', reason: 'required_fact_unavailable',
            machineIds: [publicHost.machineId], details: { requiredFact: 'publicCaddyObservation' } };
        const servers = publicHost.caddy.servers.filter(server => server.tls && server.endpoints.length > 0);
        if (servers.length !== 1) return { status: 'unavailable', reason: 'required_fact_unavailable',
            machineIds: [publicHost.machineId], details: { requiredFact: 'publicCaddyListener' } };
        placements.push({ machineId: publicHost.machineId, installationId: publicHost.installationId, dockerEngineId: publicHost.dockerEngineId,
            nativeServer: servers[0]!.serverId, listener: 'public' });
    }
    return { status: 'ready', placements, ...(tunnelOrigin ? { tunnelOrigin } : {}) };
}

export type DomainCaddyStartFirstLegsResult = Readonly<{ kind: 'ready'; legs: readonly NativeCaddyStartFirstLeg[] }>
    | Readonly<{ kind: 'unavailable' | 'conflict' | 'unknown' | 'cancelled'; reason: string; domainIds: readonly string[] }>;
type DomainContentReference = Pick<DeploymentDomainHeaderV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;

/** One finite read of the Environment's complete Domain custody. Only the native
 * owner classifies installed replica routes; edge private-origin proxies remain
 * unchanged while local replicas switch. Missing custody never means no routes. */
export async function readDomainCaddyStartFirstLegs(input: Readonly<{
    serverId: string; environmentId: string; targetLinkId: string;
    machineId: string; installationId: string; dockerEngineId: string; affectedServices: readonly string[];
    list(request: DeploymentDomainListInputV1, signal?: AbortSignal): Promise<ReturnType<typeof DeploymentDomainListResultV1Schema.parse>>;
    open(artifactId: string, signal?: AbortSignal): Promise<DeploymentArtifactDocumentV1 | null>;
    routes: Pick<ReturnType<typeof createNativeCaddyRoutes>, 'readStartFirstLeg'>;
    signal?: AbortSignal;
}>): Promise<DomainCaddyStartFirstLegsResult> {
    const domains: DeploymentDomainHeaderV1[] = [];
    let cursor: string | undefined;
    let revision: number | undefined;
    do {
        input.signal?.throwIfAborted();
        const page = await input.list({ serverId: input.serverId, environmentId: input.environmentId,
            ...(cursor === undefined ? {} : { cursor }) }, input.signal);
        if (!page.ok) return { kind: 'unavailable', reason: page.error, domainIds: [] };
        // Desired Domain additions/edits/removal intents advance this existing
        // Environment revision. Mixed pages cannot certify a complete leg set.
        if (revision !== undefined && page.revision !== revision) return { kind: 'unavailable', reason: 'deployment_conflict', domainIds: [] };
        revision = page.revision;
        domains.push(...page.domains);
        cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    // A Domain's public/private captures commonly share one Artifact. Reuse
    // the one exact opened revision inside this finite operation only.
    const content = new Map<string, ReturnType<typeof readDeploymentDomainArtifactV1>>();
    const readContent = async (reference: DomainContentReference) => {
        const key = JSON.stringify([reference.contentArtifactId, reference.contentHeaderVersion, reference.contentBodyVersion]);
        const retained = content.get(key);
        if (retained) return retained;
        input.signal?.throwIfAborted();
        const opened = readDeploymentDomainArtifactV1(reference, await input.open(reference.contentArtifactId, input.signal));
        content.set(key, opened);
        return opened;
    };
    const affected = new Set(input.affectedServices);
    const legs: NativeCaddyStartFirstLeg[] = [];
    for (const domain of domains) {
        if (domain.deletedAtMs !== undefined) continue;
        if (!domain.placements?.length) {
            const opened = await readContent(domain);
            if (!opened.ok) return { kind: 'unavailable', reason: opened.error, domainIds: [domain.id] };
            if (affected.has(opened.content.target.service)) return { kind: 'unavailable', reason: 'native_route_unavailable', domainIds: [domain.id] };
            continue;
        }
        for (const capture of domain.placements) {
            const placement = capture.placement;
            if (placement.machineId !== input.machineId) continue;
            const opened = await readContent(capture.content);
            if (!opened.ok) return { kind: 'unavailable', reason: opened.error, domainIds: [domain.id] };
            if (!affected.has(opened.content.target.service)) continue;
            if (!capture.desired || domain.state === 'removing' || placement.targetLinkId !== input.targetLinkId
                || placement.installationId !== input.installationId || capture.dockerEngineId !== input.dockerEngineId) {
                return { kind: 'unavailable', reason: 'native_route_unavailable', domainIds: [domain.id] };
            }
            const observed = await input.routes.readStartFirstLeg({ placement,
                route: { domainId: domain.id, domain: opened.content, listener: capture.listener,
                    ...(opened.content.basicAuth ? { basicAuth: [{ username: opened.content.basicAuth.username }] } : {}),
                    ...(capture.listener === 'public' ? { publicTls: opened.content.tls ?? { kind: 'managed' as const } } : {}) },
                ...(input.signal ? { signal: input.signal } : {}) });
            if (observed.kind === 'ready') legs.push(observed.leg);
            else if (observed.kind !== 'unchanged') return 'reason' in observed ? { ...observed, domainIds: [domain.id] }
                : { kind: 'unavailable', reason: 'native_route_unavailable', domainIds: [domain.id] };
        }
    }
    return { kind: 'ready', legs };
}
export type DomainPrivateOrigin = Readonly<{ machineId: string; endpoints: readonly [string, ...string[]] }>;
export type DomainPrivateOriginsSelection = Readonly<{
    status: 'ready'; network: MachinePrivateNetworkObservationV1; sourceRanges: readonly string[];
    origins: readonly [DomainPrivateOrigin, ...DomainPrivateOrigin[]];
}> | DomainRouteSelectionUnavailable;

/** P21 selects a shared native network; P20 supplies its actual published
 * listeners. No public/loopback address, implicit port or inferred range. */
export function selectPrivateCaddyOriginNetwork(input: Readonly<{
    observerNetworks: readonly MachinePrivateNetworkObservationV1[];
    members: readonly DomainCaddyMemberObservation[];
}>): DomainPrivateOriginsSelection {
    const members = input.members.filter(member => member.state === 'active');
    const unavailable = members.filter(member => member.caddy.status !== 'ready').map(member => member.machineId);
    if (!members.length || unavailable.length) return { status: 'unavailable', reason: 'required_fact_unavailable', machineIds: unavailable,
        details: members.length ? { requiredFact: 'memberCaddyObservation' } : activeDomainMembersDetails };
    for (const network of input.observerNetworks) {
        if (network.state !== 'ready' || !network.networkIdentity || !network.interfaceName || !network.sourceRanges.length) continue;
        const origins: DomainPrivateOrigin[] = [];
        for (const member of members) {
            if (member.caddy.status !== 'ready') continue;
            const endpoints = [...new Set((member.caddy.privateOrigins ?? []).filter(origin =>
                origin.network.networkIdentity === network.networkIdentity
                && accessProviderRefsEqualV1(origin.network.provider, network.provider)).map(origin => origin.endpoint))];
            if (endpoints[0] !== undefined) origins.push({ machineId: member.machineId, endpoints: [endpoints[0], ...endpoints.slice(1)] });
        }
        if (origins.length === members.length) return { status: 'ready', network, sourceRanges: network.sourceRanges,
            origins: [origins[0]!, ...origins.slice(1)] };
    }
    return { status: 'unavailable', reason: 'private_scope_unenforceable', machineIds: members.map(member => member.machineId) };
}

export type EdgeCaddyDomainRouteSelection = Readonly<{
    status: 'ready'; machineId: string; nativeServer: string; route: CaddyDomainRouteInput;
}> | DomainRouteSelectionUnavailable;

/** The selected edge routes to per-Machine Caddies; each local Caddy retains
 * sole ownership of its complete replica list. This selects no ingress mode. */
export function selectEdgeCaddyDomainRoute(input: Readonly<{
    ingress: Extract<DeploymentIngressV1, { kind: 'edgeCaddy' }>;
    domainId: string; domain: CaddyDomainRouteInput['domain'];
    edge: Readonly<{ machineId: string; caddy: NativeCaddyObservationResult; privateNetworks: readonly MachinePrivateNetworkObservationV1[] }>;
    members: readonly DomainCaddyMemberObservation[];
    basicAuth?: CaddyDomainRouteInput['basicAuth']; publicTls?: CaddyDomainRouteInput['publicTls'];
}>): EdgeCaddyDomainRouteSelection {
    if (input.edge.machineId !== input.ingress.edgeMachineId || input.edge.caddy.status !== 'ready') {
        return { status: 'unavailable', reason: 'required_fact_unavailable', machineIds: [input.ingress.edgeMachineId],
            details: { requiredFact: input.edge.machineId === input.ingress.edgeMachineId ? 'publicCaddyObservation' : 'edgeCaddyMachine' } };
    }
    const publicServers = input.edge.caddy.servers.filter(server => server.tls && server.endpoints.length > 0);
    if (publicServers.length !== 1) return { status: 'unavailable', reason: 'required_fact_unavailable', machineIds: [input.edge.machineId],
        details: { requiredFact: 'publicCaddyListener' } };
    const selected = selectPrivateCaddyOriginNetwork({ observerNetworks: input.edge.privateNetworks, members: input.members });
    if (selected.status !== 'ready') return selected;
    const [first, ...others] = selected.origins;
    return { status: 'ready', machineId: input.edge.machineId, nativeServer: publicServers[0]!.serverId,
        route: { domainId: input.domainId, domain: input.domain, listener: 'public', privateSourceRanges: [],
            upstreams: { kind: 'privateOrigins', endpoints: [first.endpoints[0], ...first.endpoints.slice(1), ...others.flatMap(origin => origin.endpoints)] },
            ...(input.basicAuth ? { basicAuth: input.basicAuth } : {}),
            ...(input.publicTls ? { publicTls: input.publicTls } : {}) } };
}
