import { z } from '../zodRuntimePolicy.js';
import type { ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import type { DeploymentAppMachineAssociationV1 } from '../machines/enrollmentV1.js';
import { readDeploymentArtifactContentV1, type DeploymentArtifactContentReferenceV1, type DeploymentArtifactDocumentV1,
    type DeploymentArtifactReadResultV1 } from './deploymentArtifactContentReferenceV1.js';
import type { DeploymentDomainHeaderV1 } from './deploymentDomainV1.js';
import { CloudflareTunnelConnectorsPerMachineV1Schema } from './cloudflareTunnelConnectorsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AccessProviderSelectionV1Schema } from '../plugins/contributions/accessProviders.js';
import { DeploymentDomainHealthCheckV1Schema } from './deploymentDomainHealthCheckV1.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';
import { DeploymentDomainProviderResultV1Schema, DeploymentDomainProviderZoneV1Schema,
    DeploymentDomainTunnelOwnershipV1Schema } from './deploymentDomainProviderResultV1.js';
export { DeploymentDomainProviderResultV1Schema, type DeploymentDomainProviderResultV1 } from './deploymentDomainProviderResultV1.js';

const path = z.string().check(z.startsWith('/'));

/** Private desired routing input; native custody remains on the Domain owner. */
export const DeploymentDomainContentV1Schema = lazyZodSchema(() => z.strictObject({
    hostname: z.nullable(text),
    target: z.union([z.strictObject({ service: text, kind: z.optional(z.literal('native')),
        containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
        path: z.optional(path), redirectTo: z.optional(text) }),
    z.strictObject({ kind: z.literal('telemetry'), service: z.optional(z.never()), containerPort: z.optional(z.never()),
        path: z.optional(z.never()), redirectTo: z.optional(z.never()) }),
    z.strictObject({ kind: z.literal('provider'), zone: z.optional(DeploymentDomainProviderZoneV1Schema), service: z.optional(z.never()), containerPort: z.optional(z.never()),
        path: z.optional(z.never()), redirectTo: z.optional(z.never()) })]),
    providerObservation: z.optional(DeploymentDomainProviderResultV1Schema),
    healthCheck: z.optional(DeploymentDomainHealthCheckV1Schema),
    ingress: z.optional(AccessProviderSelectionV1Schema),
    cloudflarePreparation: z.optional(z.strictObject({
        tunnelId: text,
        tunnelOwnership: z.optional(DeploymentDomainTunnelOwnershipV1Schema),
        owned: z.array(z.strictObject({ hostname: text, path: z.optional(path), expectedService: text })),
        dnsOwnership: z.array(z.strictObject({ hostname: text, recordId: text })),
        connectorsPerMachine: z.optional(CloudflareTunnelConnectorsPerMachineV1Schema),
        connectors: z.optional(z.array(z.strictObject({ machineId: text, installationId: text,
            imageRef: text, version: text, networkName: text, grantRef: text }))),
    })),
    tls: z.optional(z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('managed') }),
        z.strictObject({ kind: z.literal('custom') }),
    ])),
    basicAuth: z.optional(z.strictObject({ username: text })),
}).check(z.refine(content => content.hostname !== null || (
    content.target.kind === 'provider' && !content.target.zone && !content.providerObservation
    && !content.healthCheck && !content.ingress && !content.cloudflarePreparation && !content.tls && !content.basicAuth
), { message: 'Only a provider-assigned Domain can await its hostname.' })));
export type DeploymentDomainContentV1 = z.infer<typeof DeploymentDomainContentV1Schema>;

/** Syntax only: DNS resolution and native routing retain their own observations. */
export function readDeploymentDomainHostnameV1(value: unknown): string | null {
    const parsed = text.safeParse(value);
    if (!parsed.success) return null;
    try {
        const hostname = parsed.data;
        if (/[\s/%\\?#@:]/u.test(hostname) || hostname.includes('*')) return null;
        const address = new URL(`https://${hostname}`);
        if (address.port || address.username || address.password || address.pathname !== '/' || address.search || address.hash) return null;
        // The URL parser canonicalizes IDNs and IPv4 but also accepts punctuation that a DNS label cannot contain.
        const normalized = address.hostname.replace(/\.$/, '');
        return normalized.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
            ? normalized : null;
    } catch { return null; }
}

/** The configured ingress address remains the address even when that route redirects. */
export function readDeploymentDomainServingUrlV1(content: unknown): string | null {
    const parsed = DeploymentDomainContentV1Schema.safeParse(content);
    if (!parsed.success) return null;
    try {
        const hostname = readDeploymentDomainHostnameV1(parsed.data.hostname);
        if (!hostname) return null;
        const address = new URL(`https://${hostname}`);
        address.pathname = parsed.data.target.path ?? '/';
        return address.href;
    } catch { return null; }
}

export function readDeploymentDomainArtifactV1(reference: DeploymentArtifactContentReferenceV1, artifact: DeploymentArtifactDocumentV1 | null):
    DeploymentArtifactReadResultV1<DeploymentDomainContentV1> {
    return readDeploymentArtifactContentV1(reference, artifact, DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, DeploymentDomainContentV1Schema);
}

/** An installation consumes only its own saved connector. */
export function readDeploymentDomainCloudflareConnectorV1(content: DeploymentDomainContentV1,
    target: Readonly<{ machineId: string; installationId: string }>) {
    const prepared = content.cloudflarePreparation;
    const connector = prepared?.connectors?.find(item => item.machineId === target.machineId && item.installationId === target.installationId);
    return prepared && connector ? { prepared, connector } : undefined;
}

export type PublicTelemetryCollectorDomainInputV1 = Readonly<{
    serverId: string; environmentId: string; targetLinkId: string; domainId: string;
    collector: Pick<DeploymentAppMachineAssociationV1, 'deploymentId' | 'controller'> & Readonly<{ machineId: string }>;
    domain: DeploymentDomainHeaderV1 | null;
    open(artifactId: string, signal?: AbortSignal): Promise<DeploymentArtifactDocumentV1 | null>;
    signal?: AbortSignal;
}>;

export type PublicTelemetryCollectorDomainResultV1 = Readonly<{ kind: 'ready'; endpoint: string }>
    | Readonly<{ kind: 'unavailable'; reason: string;
        state?: DeploymentDomainHeaderV1['state'] | 'unbound' | 'private_only';
        failureCause?: ActionFailureCauseV1 }>;

/** Use an already admitted Domain row and open its exact collector capture at the caller's existing Artifact boundary. */
export async function selectPublicTelemetryCollectorDomainV1(input: PublicTelemetryCollectorDomainInputV1):
    Promise<PublicTelemetryCollectorDomainResultV1> {
    const { domain, serverId, environmentId, targetLinkId, domainId, collector, signal } = input;
    signal?.throwIfAborted();
    if (!domain) return { kind: 'unavailable', reason: 'deployment_unavailable' };
    if (domain.id !== domainId || domain.environmentId !== environmentId || domain.targetLinkId !== targetLinkId)
        return { kind: 'unavailable', reason: 'target_mismatch' };
    if (domain.deletedAtMs !== undefined) return { kind: 'unavailable', reason: 'deployment_unavailable' };
    if (domain.state !== 'active') return { kind: 'unavailable', reason: 'collector_route_unavailable', state: domain.state };
    const placements = domain.placements?.filter(({ desired, placement }) => desired && placement.serverId === serverId
        && placement.environmentId === environmentId && placement.domainId === domainId && placement.targetLinkId === targetLinkId) ?? [];
    const origin = placements.find(({ listener, placement }) => listener === 'privateOrigin'
        && placement.machineId === collector.controller.machineId && placement.installationId === collector.controller.installationId);
    if (!origin) return { kind: 'unavailable', reason: 'target_mismatch' };
    if (!origin.telemetryCollector) return { kind: 'unavailable', reason: 'collector_route_unavailable', state: 'unbound' };
    if (origin.telemetryCollector.machineId !== collector.machineId || origin.telemetryCollector.deploymentId !== collector.deploymentId)
        return { kind: 'unavailable', reason: 'target_mismatch' };
    signal?.throwIfAborted();
    const opened = readDeploymentDomainArtifactV1(origin.content, await input.open(origin.content.contentArtifactId, signal));
    if (!opened.ok) return { kind: 'unavailable', reason: opened.error, failureCause: opened.failureCause };
    const content = opened.content;
    if (content.target.kind !== 'telemetry') return { kind: 'unavailable', reason: 'target_mismatch' };
    // The native listener and the prepared tunnel are produced by Domain Add.
    // A tunnel serves public HTTPS even though its Caddy listener is private.
    const publicListener = placements.some(({ listener }) => listener === 'public');
    const tunnel = readDeploymentDomainCloudflareConnectorV1(content, origin.placement)?.prepared.owned.some(route => route.hostname === content.hostname);
    if (!publicListener && !tunnel) return { kind: 'unavailable', reason: 'collector_route_unavailable', state: 'private_only' };
    const endpoint = readDeploymentDomainServingUrlV1(content);
    return endpoint ? { kind: 'ready', endpoint } : { kind: 'unavailable', reason: 'deployment_content_unavailable' };
}
