import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import type { DaemonProviderConnectionsDescribeResponseV1, DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AccountProviderCatalogCountV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { readAccountProviderDeclaration } from '@/providers/catalog/accountProviderDeclarations';

import {
    presentProviderConnection,
    providerConnectionNeedsAttention,
    type ProviderConnectionPresentationStatus,
} from '@/providers/connection/presentation';
import { readProviderGatewayContributionPurposes } from '@/providers/connection/gatewayConfiguration';
import { readProviderContributionIcon } from '@/providers/catalog/accountProviderDeclarations';

type DescribeSuccess = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type Connection = DescribeSuccess['connections'][number];
type LocalInstallation = DescribeSuccess['localInstallations'][number];
export type ProviderAvailableContribution = DescribeSuccess['available'][number];

export type ProviderCollectionConnectionRow = Readonly<{
    connectionId: string;
    detailRoute: string;
    title: string;
    /** The provider behind a named connection ("OpenRouter" for "Personal"); empty when it is the title. */
    provenance: string;
    /** It signs in with a saved API key (the rail says "API key"). */
    keySaved: boolean;
    catalogCount: AccountProviderCatalogCountV1 | null;
    icon: string | null;
    contributionKey: string | null;
    status: ProviderConnectionPresentationStatus;
    trouble: boolean;
    /** Turned off everywhere: dimmed in the list, still selectable. */
    off: boolean;
    /** A gateway is configured from Connected services; this collection lists it and opens the same detail. */
    gateway: boolean;
    /** A gateway with no account behind its purposes yet (the typed `managed_purpose_bindings_missing` cause). */
    needsAccount: boolean;
}>;

/** A local model server on the managed machine that is not a connection yet. */
export type ProviderCollectionFoundRow =
    | Readonly<{
        kind: 'candidate';
        key: string;
        pendingKey: string;
        title: string;
        icon: string | null;
        candidate: ProviderDiscoveryCandidateV1;
    }>
    | Readonly<{
        kind: 'installation';
        key: string;
        pendingKey: string;
        title: string;
        icon: string | null;
        installation: LocalInstallation;
    }>;

export type ProviderCollection = Readonly<{
    connections: readonly ProviderCollectionConnectionRow[];
    found: readonly ProviderCollectionFoundRow[];
    /** Rows before the search filter, for the rail count and the search threshold. */
    total: number;
}>;

const EMPTY_COLLECTION: ProviderCollection = Object.freeze({ connections: [], found: [], total: 0 });

export function providerCandidatePendingKey(candidate: Pick<ProviderDiscoveryCandidateV1, 'contributionKey' | 'normalizedEndpointUrl'>): string {
    return `detected:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`;
}

export function providerInstallationPendingKey(contributionKey: string): string {
    return `start:${contributionKey}`;
}

/** A gateway has no provider logo of its own: its rail row and its detail header share this glyph. */
export const PROVIDER_GATEWAY_ICON = 'path';

/**
 * The fallback glyph for rail, detail and Models headers. ProviderIcon resolves the
 * manifest's packaged brand first using the connection's contribution identity.
 */
export function resolveProviderConnectionIcon(connection: DaemonProviderConnectionViewV1 | ProviderConnectionV1,
    declarationContext: ProviderDeclarationContext): string | null {
    const saved = 'source' in connection;
    const contributionKey = saved
        ? connection.source.kind === 'contribution' ? connection.source.contributionKey : null
        : connection.contributionKey;
    const purposes = saved ? readProviderGatewayPurposeDeclarations(connection, declarationContext) : readProviderGatewayViewDeclarations(connection, declarationContext);
    return (saved ? null : connection.icon)
        ?? readProviderContributionIcon(contributionKey, declarationContext)
        ?? ((purposes?.length ?? 0) > 0 ? PROVIDER_GATEWAY_ICON : null);
}

function presentConnectionRow(connection: Connection, catalogCount: AccountProviderCatalogCountV1 | null,
    declarationContext: ProviderDeclarationContext): ProviderCollectionConnectionRow {
    const presentation = presentProviderConnection(connection);
    const gateway = (readProviderGatewayViewDeclarations(connection, declarationContext)?.length ?? 0) > 0;
    return {
        connectionId: connection.connectionId,
        detailRoute: providerConnectionDetailRoute(connection.connectionId),
        title: presentation.title,
        provenance: presentation.subtitle,
        keySaved: connection.credential?.accountBound === true,
        // A gateway serves its Connected accounts' models; the Account's saved catalog never holds them.
        catalogCount: gateway ? null : catalogCount,
        icon: resolveProviderConnectionIcon(connection, declarationContext),
        contributionKey: connection.contributionKey,
        status: presentation.status,
        trouble: providerConnectionNeedsAttention(presentation.status),
        off: presentation.status === 'disabled',
        gateway,
        needsAccount: gateway && connection.authorizationError?.code === 'provider_connection_invalid'
            && connection.authorizationError.reason === 'managed_purpose_bindings_missing',
    };
}

/**
 * The Providers collection read from one machine's projection: the connections this Account has,
 * then the local model servers found on the machine that are not connections yet. A detected server
 * already matched to a listed connection is that connection, so it is not listed twice.
 */
export function buildProviderCollection(input: Readonly<{
    data: DescribeSuccess | null;
    query: string;
    localDiscoveryEnabled: boolean;
    catalogCounts?: Readonly<Record<string, AccountProviderCatalogCountV1>> | null;
    declarationContext: ProviderDeclarationContext;
}>): ProviderCollection {
    const { data } = input;
    if (!data) return EMPTY_COLLECTION;
    const connectionIds = new Set(data.connections.map((connection) => connection.connectionId));
    const allConnections = data.connections.map(connection => presentConnectionRow(connection,
        input.catalogCounts?.[connection.connectionId] ?? null, input.declarationContext));

    const allFound: ProviderCollectionFoundRow[] = [];
    if (input.localDiscoveryEnabled) {
        for (const candidate of data.discoveryCandidates) {
            if (candidate.connection.status === 'matched' && connectionIds.has(candidate.connection.connectionId)) continue;
            allFound.push({
                kind: 'candidate',
                key: `candidate:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`,
                pendingKey: providerCandidatePendingKey(candidate),
                title: candidate.providerName,
                icon: readProviderContributionIcon(candidate.contributionKey, input.declarationContext),
                candidate,
            });
        }
        // A running server already stands for its installation.
        const candidateContributions = new Set(data.discoveryCandidates.map((candidate) =>
            canonicalizeProviderContributionKeyV1(candidate.contributionKey)));
        for (const installation of data.localInstallations) {
            if (candidateContributions.has(canonicalizeProviderContributionKeyV1(installation.contributionKey))) continue;
            allFound.push({
                kind: 'installation',
                key: `installation:${installation.contributionKey}`,
                pendingKey: providerInstallationPendingKey(installation.contributionKey),
                title: installation.providerName,
                icon: readProviderContributionIcon(installation.contributionKey, input.declarationContext),
                installation,
            });
        }
    }

    return filterProviderCollection({
        connections: allConnections,
        found: allFound,
        total: allConnections.length + allFound.length,
    }, input.query);
}

/** Search narrows the held collection without rebuilding its rows or changing the condition corpus. */
export function filterProviderCollection(collection: ProviderCollection, searchQuery: string): ProviderCollection {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return collection;
    const matches = (...texts: readonly string[]) => texts.join(' ').toLocaleLowerCase().includes(query);
    return {
        ...collection,
        connections: collection.connections.filter(row => matches(row.title, row.provenance)),
        found: collection.found.filter(row => matches(row.title)),
    };
}

/** Both Settings collections open the one Provider connection detail. */
export function providerConnectionDetailRoute(connectionId: string): string {
    return `/(app)/settings/providers/${encodeURIComponent(connectionId)}`;
}

/** One authoring destination for catalog, Custom and discovered Provider picks. */
export function newProviderRoute(contributionKey: string | null, seed?: Readonly<{
    candidateId?: string;
    displayName?: string | null;
}>): string {
    const params: Array<readonly [string, string]> = [];
    if (contributionKey) params.push(['contributionKey', contributionKey]);
    if (seed?.candidateId) params.push(['candidateId', seed.candidateId]);
    if (seed?.displayName) params.push(['displayName', seed.displayName]);
    const query = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return `/(app)/settings/providers/new${query ? `?${query}` : ''}`;
}

export type ProviderGatewayCollectionRow = Readonly<{
    connectionId: string;
    title: string;
    detailRoute: string;
    revision: number;
    /** The vendor services whose slot is set, in the contribution's order: what the gateway draws on. */
    slotServices: readonly PluginContributionIdentityV1[];
    /** On for the Account: the grant its header switch writes. */
    enabled: boolean;
}>;

/** Immutable vendor declarations distinguish a gateway from other managed sources such as Ollama. */
export function readProviderGatewayPurposeDeclarations(
    saved: ProviderConnectionV1,
    declarationContext: ProviderDeclarationContext,
): NonNullable<DaemonProviderConnectionViewV1['managedLocalOption']>['connectedAccountPurposes'] | null {
    if (saved.deployment.kind !== 'managedLocal' || saved.source.kind !== 'contribution') return null;
    const declaration = readAccountProviderDeclaration(saved.source.contributionKey, declarationContext);
    return readProviderGatewayContributionPurposes(saved.source.contributionKey, declaration ? [declaration] : []);
}

/** Projected rows use the same admitted declaration source as saved connections. */
export function readProviderGatewayViewDeclarations(
    view: DaemonProviderConnectionViewV1,
    declarationContext: ProviderDeclarationContext,
): NonNullable<DaemonProviderConnectionViewV1['managedLocalOption']>['connectedAccountPurposes'] | null {
    if (view.deployment.kind !== 'managedLocal' || !view.contributionKey) return null;
    const declaration = readAccountProviderDeclaration(view.contributionKey, declarationContext);
    return readProviderGatewayContributionPurposes(view.contributionKey, declaration ? [declaration] : []);
}

/** Declaration completeness only; unknown sources never block independently admitted gateway rows. */
export function areProviderGatewayDeclarationsKnown(input: Readonly<{
    connections: readonly ProviderConnectionV1[];
    declarationContext: ProviderDeclarationContext;
}>): boolean {
    return input.connections.every(connection => connection.deployment.kind !== 'managedLocal'
        || readProviderGatewayPurposeDeclarations(connection, input.declarationContext) !== null);
}

/** Saved identity and admitted bundled declarations suffice; no machine projection is required. */
/**
 * The one "is this gateway on" fact: admitted for the Account and enabled on a machine to run on. The
 * gateway's header switch writes both, so the rail, the gateway page and a pool's "Use in other agents"
 * read the same answer.
 */
export function isProviderGatewayOn(grants: Readonly<{ accountEnabled: boolean; enabledMachineCount: number }>): boolean {
    return grants.accountEnabled && grants.enabledMachineCount > 0;
}

/** `isProviderGatewayOn` from the Account catalog's saved grants. */
export function isProviderGatewayOnInCatalog(input: Readonly<{
    connectionId: string;
    accountGrants: readonly Readonly<{ connectionId: string }>[];
    machineGrants: readonly Readonly<{ connectionId: string }>[];
}>): boolean {
    return isProviderGatewayOn({
        accountEnabled: input.accountGrants.some(grant => grant.connectionId === input.connectionId),
        enabledMachineCount: input.machineGrants.filter(grant => grant.connectionId === input.connectionId).length,
    });
}

export function buildProviderGatewayCollection(input: Readonly<{
    connections: readonly ProviderConnectionV1[];
    declarationContext: ProviderDeclarationContext;
    accountGrants: readonly Readonly<{ connectionId: string }>[];
    machineGrants: readonly Readonly<{ connectionId: string }>[];
}>): readonly ProviderGatewayCollectionRow[] {
    return input.connections.flatMap(connection => {
        const purposes = readProviderGatewayPurposeDeclarations(connection, input.declarationContext) ?? [];
        if (purposes.length === 0) return [];
        const bound = connection.purposeBindingDefaults ?? {};
        return [{ connectionId: connection.id, title: connection.displayName,
            detailRoute: providerConnectionDetailRoute(connection.id), revision: connection.revision,
            slotServices: purposes.filter(({ purpose }) => bound[purpose]).map(({ service }) => service),
            enabled: isProviderGatewayOnInCatalog({ connectionId: connection.id, accountGrants: input.accountGrants, machineGrants: input.machineGrants }) }];
    });
}

/** A saved custom connection's editor: the same page as its detail, opened in the custom editor (F08). */
export function providerConnectionEditRoute(connectionId: string): string {
    return `${providerConnectionDetailRoute(connectionId)}?edit=1`;
}

/** The former query value that opened a connection's detail on its Models section (old links). */
export const PROVIDER_CONNECTION_MODELS_SECTION = 'models';

/**
 * A connection's Models page, behind the "Models" row of its detail (lab PD1), optionally with the
 * manual-model editor open.
 */
export function providerConnectionModelsRoute(connectionId: string, options: Readonly<{ add?: boolean }> = {}): string {
    return `${providerConnectionDetailRoute(connectionId)}/models${options.add ? '?add=1' : ''}`;
}
