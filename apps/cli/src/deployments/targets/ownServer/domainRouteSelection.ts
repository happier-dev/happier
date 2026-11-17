import type { MachineDeploymentDomainReferenceV1 } from '@happier-dev/protocol/machines/machineDeploymentDomainReferenceV1';
import type { NativeCaddyObservationResult } from '@happier-dev/cli-common/machineSetup';
import { readCloudflareNamedControllerSelection } from '@happier-dev/cli-common/relayAccess';
import { accessProviderRefsEqualV1, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { DeploymentIngressV1, DeploymentDomainAddInputV1, DeploymentDomainHeaderV1,
    DeploymentDomainListInputV1, DeploymentDomainListResultV1Schema, DeploymentDomainTopologyV1,
    DeploymentDomainMachineTopologyV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1, type DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol';
import type { createNativeCaddyRoutes, NativeCaddyStartFirstLeg } from '@/machines/reachability/nativeCaddyRoutes';
import { caddyPublicHttpServerId, type CaddyDomainRouteInput } from './caddyRouteMaterialization';
import type { Machine } from '@/api/types';

type ResolvedDomainIngress = Readonly<{ status: 'ready'; ingress?: DeploymentIngressV1;
    selection: ReturnType<typeof readCloudflareNamedControllerSelection> }>
    | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable';
        details: Readonly<{ requiredFact: 'cloudflare_selection_required'; remedy: string }> }>;

/** Environment topology never supplies the private named controller or credentials.
 * Tunnel Add resolves a full selection before admission; native placement decides
 * whether absent topology is unambiguous. Accepted native work consumes the result. */
export function resolveDomainIngress(domain: DeploymentDomainContentV1, ingress?: DeploymentIngressV1,
    requireSelection = false): ResolvedDomainIngress {
    const selection = readCloudflareNamedControllerSelection(domain.ingress);
    if (requireSelection && !selection && ingress?.kind === 'cloudflareTunnel') return {
        status: 'unavailable', reason: 'required_fact_unavailable', details: {
            requiredFact: 'cloudflare_selection_required',
            remedy: 'Choose a named Cloudflare tunnel and zone, then add the Domain again.',
        },
    };
    return { status: 'ready', ingress: selection ? { kind: 'cloudflareTunnel' } : ingress, selection };
}

export type DomainCaddyMemberObservation = Readonly<{
    machineId: string; state: 'active' | 'joining'; caddy: NativeCaddyObservationResult;
}>;
type DomainMemberIdentity = Readonly<{ machineId: string; installationId: string }>;

/** Ordinary Domains follow active membership; an admitted membership child
 * consumes its exact desired installations, including healthy joining members. */
export function selectDomainIngressMembers<T extends DomainMemberIdentity & Readonly<{ state: 'active' | 'joining' }>>(
    members: readonly T[], membershipMachines?: readonly DomainMemberIdentity[],
): Array<T & Readonly<{ state: 'active' }>> {
    return members.filter(member => membershipMachines
        ? membershipMachines.some(desired => desired.machineId === member.machineId && desired.installationId === member.installationId)
        : member.state === 'active').map(member => ({ ...member, state: 'active' as const }));
}

/** A retained serving installation can still be marked joining after a failed
 * rollout. Its incumbent receipt, rather than the next placement's flag, owns
 * whether it already runs a release. Membership children keep their exact set. */
export async function readDomainIngressMembersForHost(
    link: import('@happier-dev/deployment-protocol').DeploymentTargetLinkHeaderV1,
    membershipMachines: readonly DomainMemberIdentity[] | undefined,
    context: import('@happier-dev/protocol').ActionExecutorContext,
    readReceipt: import('./ownServerDeploymentTarget').OwnServerDeploymentTargetHostInput['readReceipt'],
) {
    if (membershipMachines || !link.activeDeploymentId || !link.members.some(member => member.state === 'joining'))
        return selectDomainIngressMembers(link.members, membershipMachines);
    const receipt = await readReceipt({ environmentId: link.environmentId, deploymentId: link.activeDeploymentId, context });
    const serving = link.members.filter(member => member.state === 'active' || receipt.content.machineResults.some(row =>
        row.machineId === member.machineId && row.installationId === member.installationId && row.currentDeploymentId !== undefined));
    return selectDomainIngressMembers(link.members, serving);
}

/** The admitted root names removed members; the remaining set also owns ingress. */
export function selectDomainMembershipMachines(members: readonly DomainMemberIdentity[], drainingMachines?: readonly string[]): DomainMemberIdentity[] {
    const draining = new Set(drainingMachines);
    return members.filter(member => !draining.has(member.machineId)).map(({ machineId, installationId }) => ({ machineId, installationId }));
}
// The recovery owner (protocol deploymentFailureRecoveryV1) states this fact's one remedy, Deploy.
const activeDomainMembersDetails = { requiredFact: 'activeDomainMembers' } as const;
export type DomainRouteSelectionUnavailable = Readonly<{
    status: 'unavailable'; machineIds: readonly string[];
}> & (Readonly<{ reason: 'required_fact_unavailable'; details: Readonly<{ requiredFact: string; remedy?: string }> }>
    | Readonly<{ reason: 'private_scope_unenforceable'; details?: never }>);
/** Public ingress is independent of workload membership and private listeners. */
export function selectDomainPublicCaddyServer(input: Pick<DomainCaddyMemberObservation, 'machineId' | 'caddy'>):
    Readonly<{ status: 'ready'; nativeServer: string }> | DomainRouteSelectionUnavailable {
    if (input.caddy.status !== 'ready') return { status: 'unavailable', reason: 'required_fact_unavailable',
        machineIds: [input.machineId], details: { requiredFact: 'publicCaddyObservation' } };
    const servers = input.caddy.servers.filter(server => server.tls && server.endpoints.length > 0);
    if (servers.length !== 1) return { status: 'unavailable', reason: 'required_fact_unavailable',
        machineIds: [input.machineId], details: { requiredFact: 'publicCaddyListener' } };
    return { status: 'ready', nativeServer: servers[0]!.serverId };
}
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
    const members = selectDomainIngressMembers(input.members);
    if (!members.length || !input.ingress && members.length > 1) return { status: 'unavailable',
        reason: 'required_fact_unavailable', machineIds: members.map(member => member.machineId),
        details: members.length ? { requiredFact: 'domain_ingress_required',
            remedy: 'No ingress is recorded for this multi-Machine Environment. Choose the Domain ingress before adding it.' }
            : activeDomainMembersDetails };
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
        const selected = selectDomainPublicCaddyServer(publicHost);
        if (selected.status !== 'ready') return selected;
        placements.push({ machineId: publicHost.machineId, installationId: publicHost.installationId, dockerEngineId: publicHost.dockerEngineId,
            nativeServer: selected.nativeServer, listener: 'public' });
    }
    return { status: 'ready', placements, ...(tunnelOrigin ? { tunnelOrigin } : {}) };
}

export type DomainCaddyStartFirstLegsResult = Readonly<{ kind: 'ready'; legs: readonly NativeCaddyStartFirstLeg[] }>
    | Readonly<{ kind: 'unavailable' | 'conflict' | 'unknown' | 'cancelled'; reason: string; domainIds: readonly string[] }>;
type DomainContentReference = Pick<DeploymentDomainHeaderV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;

type DomainInventoryInput = Readonly<{
    serverId: string; environmentId: string; targetLinkId: string;
    list(request: DeploymentDomainListInputV1, signal?: AbortSignal): Promise<ReturnType<typeof DeploymentDomainListResultV1Schema.parse>>;
    open(artifactId: string, signal?: AbortSignal): Promise<DeploymentArtifactDocumentV1 | null>;
    signal?: AbortSignal;
}>;

export async function readDeploymentDomainInventoryForHost(input: Pick<DomainInventoryInput, 'serverId' | 'environmentId' | 'list' | 'signal'>): Promise<Readonly<{ kind: 'ready'; domains: readonly DeploymentDomainHeaderV1[] }>
    | Exclude<DomainCaddyStartFirstLegsResult, { kind: 'ready' }>> {
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
    return { kind: 'ready', domains };
}

function createDomainContentReader(input: DomainInventoryInput) {
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
    return readContent;
}

export type TelemetryCollectorDomainEndpoint = Readonly<{ kind: 'ready'; endpoint: string }>
    | Readonly<{ kind: 'unavailable'; reason: string }>;

export type TelemetryCollectorPlacement = Readonly<{ kind: 'ready'; machineId: string; installationId: string;
    app?: NonNullable<DeploymentDomainMachineTopologyV1['telemetryApp']> }>
    | Readonly<{ kind: 'unavailable'; reason: string }>;

/** Machine's receipt association owns placement; its opened metadata supplies
 * private native service identity. Neither fact is inferred from a Domain. */
export function readTelemetryCollectorPlacementForHost(machine: Pick<Machine, 'id' | 'installationId' | 'deploymentApp'>
    & Readonly<{ metadata: Pick<NonNullable<Machine['metadata']>, 'deploymentApp'> | null }>): TelemetryCollectorPlacement {
    if (!machine.deploymentApp) return machine.installationId ? { kind: 'ready', machineId: machine.id,
        installationId: machine.installationId } : { kind: 'unavailable', reason: 'target_mismatch' };
    const binding = machine.metadata?.deploymentApp;
    if (!binding) return { kind: 'unavailable', reason: machine.metadata === null
        ? 'machine_content_key_unavailable' : 'collector_route_unavailable' };
    return { kind: 'ready', ...machine.deploymentApp.controller,
        app: { environmentId: machine.deploymentApp.environmentId, ...binding } };
}

/** The Domain owner selects the admitted collector route and observes its actual
 * native privateOrigin. A public hostname is never a substitute for shared scope. */
export async function readTelemetryCollectorDomainForHost(input: DomainInventoryInput & Readonly<{
    collectorMachineId: string;
    observerNetworks: readonly MachinePrivateNetworkObservationV1[];
    observe(domain: DeploymentDomainHeaderV1, capture: NonNullable<DeploymentDomainHeaderV1['placements']>[number]):
        Promise<DeploymentDomainMachineTopologyV1 | null>;
}>): Promise<TelemetryCollectorDomainEndpoint> {
    const inventory = await readDeploymentDomainInventoryForHost(input);
    if (inventory.kind !== 'ready') return { kind: 'unavailable', reason: inventory.reason };
    const readContent = createDomainContentReader(input);
    for (const domain of inventory.domains) {
        if (domain.deletedAtMs !== undefined || domain.state === 'removing') continue;
        for (const capture of domain.placements ?? []) {
            const placement = capture.placement;
            if (!capture.desired || capture.listener !== 'privateOrigin' || placement.machineId !== input.collectorMachineId
                || placement.environmentId !== input.environmentId || placement.targetLinkId !== input.targetLinkId) continue;
            const opened = await readContent(capture.content);
            if (!opened.ok) return { kind: 'unavailable', reason: opened.error };
            if (opened.content.target.kind !== 'telemetry') continue;
            const topology = await input.observe(domain, capture);
            if (!topology) return { kind: 'unavailable', reason: 'collector_route_unavailable' };
            if (topology.machineId !== placement.machineId || topology.installationId !== placement.installationId
                || topology.dockerEngineId !== capture.dockerEngineId) return { kind: 'unavailable', reason: 'target_mismatch' };
            const selected = selectPrivateCaddyOriginNetwork({ observerNetworks: input.observerNetworks,
                members: [{ machineId: topology.machineId, state: 'active', caddy: topology.caddy }] });
            if (selected.status !== 'ready') return { kind: 'unavailable', reason: selected.reason };
            return { kind: 'ready', endpoint: new URL(`http://${selected.origins[0].endpoints[0]}`).origin };
        }
    }
    return { kind: 'unavailable', reason: 'collector_route_unavailable' };
}

/** Exact retained Domain subjects whose declared backend is interrupted by this operation. */
export async function readExpectedDownDomainReferencesForHost(input: DomainInventoryInput & Readonly<{
    affectedServices: readonly string[];
}>): Promise<readonly MachineDeploymentDomainReferenceV1[] | null> {
    const inventory = await readDeploymentDomainInventoryForHost(input);
    if (inventory.kind !== 'ready') return null;
    const readContent = createDomainContentReader(input);
    const affected = new Set(input.affectedServices);
    const references: MachineDeploymentDomainReferenceV1[] = [];
    for (const domain of inventory.domains) {
        if (domain.deletedAtMs !== undefined || domain.state === 'removing') continue;
        const placements = new Set<string>();
        for (const capture of domain.placements ?? []) {
            if (!capture.desired || capture.placement.targetLinkId !== input.targetLinkId) continue;
            const opened = await readContent(capture.content);
            if (!opened.ok) return null;
            const service = opened.content.target.service;
            if (service === undefined || !affected.has(service)) continue;
            const identity = JSON.stringify([capture.placement.machineId, capture.placement.installationId]);
            if (placements.has(identity)) continue;
            placements.add(identity);
            references.push({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, domainId: domain.id,
                machineId: capture.placement.machineId, installationId: capture.placement.installationId });
        }
    }
    return references;
}


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
    const inventory = await readDeploymentDomainInventoryForHost(input);
    if (inventory.kind !== 'ready') return inventory;
    const { domains } = inventory;
    const readContent = createDomainContentReader(input);
    const affected = new Set(input.affectedServices);
    const legs: NativeCaddyStartFirstLeg[] = [];
    for (const domain of domains) {
        if (domain.deletedAtMs !== undefined) continue;
        if (!domain.placements?.length) {
            const opened = await readContent(domain);
            if (!opened.ok) return { kind: 'unavailable', reason: opened.error, domainIds: [domain.id] };
            const service = opened.content.target.service;
            if (service !== undefined && affected.has(service)) return { kind: 'unavailable', reason: 'native_route_unavailable', domainIds: [domain.id] };
            continue;
        }
        for (const capture of domain.placements) {
            const placement = capture.placement;
            if (placement.machineId !== input.machineId) continue;
            const opened = await readContent(capture.content);
            if (!opened.ok) return { kind: 'unavailable', reason: opened.error, domainIds: [domain.id] };
            const service = opened.content.target.service;
            if (service === undefined || !affected.has(service)) continue;
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
    const publicServer = selectDomainPublicCaddyServer(input.edge);
    if (publicServer.status !== 'ready') return publicServer;
    const selected = selectPrivateCaddyOriginNetwork({ observerNetworks: input.edge.privateNetworks, members: input.members });
    if (selected.status !== 'ready') return selected;
    const [first, ...others] = selected.origins;
    return { status: 'ready', machineId: input.edge.machineId, nativeServer: publicServer.nativeServer,
        route: { domainId: input.domainId, domain: input.domain, listener: 'public', privateSourceRanges: [],
            upstreams: { kind: 'privateOrigins', endpoints: [first.endpoints[0], ...first.endpoints.slice(1), ...others.flatMap(origin => origin.endpoints)] },
            ...(input.basicAuth ? { basicAuth: input.basicAuth } : {}),
            ...(input.publicTls ? { publicTls: input.publicTls } : {}) } };
}
