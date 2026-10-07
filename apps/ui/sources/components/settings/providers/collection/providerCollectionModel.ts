import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';

import {
    presentProviderConnection,
    type ProviderConnectionPresentationStatus,
} from '@/providers/connection/presentation';
import { createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

type DescribeSuccess = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type Connection = DescribeSuccess['connections'][number];
type LocalInstallation = DescribeSuccess['localInstallations'][number];
export type ProviderAvailableContribution = DescribeSuccess['available'][number];

/** Statuses that need the user; only these get the rail's trouble dot and a status line. */
const TROUBLE_STATUSES: ReadonlySet<ProviderConnectionPresentationStatus> = new Set([
    'partial', 'needsAttention', 'unreachable', 'sourceUnavailable',
]);

export type ProviderCollectionConnectionRow = Readonly<{
    connectionId: string;
    title: string;
    /** The provider behind a named connection ("OpenRouter" for "Personal"); empty when it is the title. */
    provenance: string;
    modelCount: number | null;
    icon: string | null;
    status: ProviderConnectionPresentationStatus;
    trouble: boolean;
    /** Turned off everywhere: dimmed in the list, still selectable. */
    off: boolean;
}>;

/** A local model server on the managed machine that is not a connection yet. */
export type ProviderCollectionFoundRow =
    | Readonly<{
        kind: 'candidate';
        key: string;
        pendingKey: string;
        title: string;
        candidate: ProviderDiscoveryCandidateV1;
    }>
    | Readonly<{
        kind: 'installation';
        key: string;
        pendingKey: string;
        title: string;
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

function presentConnectionRow(connection: Connection): ProviderCollectionConnectionRow {
    const presentation = presentProviderConnection(connection);
    return {
        connectionId: connection.connectionId,
        title: presentation.title,
        provenance: presentation.subtitle,
        modelCount: presentation.modelCount,
        icon: connection.icon,
        status: presentation.status,
        trouble: TROUBLE_STATUSES.has(presentation.status),
        off: presentation.status === 'disabled',
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
}>): ProviderCollection {
    const { data } = input;
    if (!data) return EMPTY_COLLECTION;
    const query = input.query.trim().toLocaleLowerCase();
    const matches = (...texts: readonly string[]) => !query
        || texts.join(' ').toLocaleLowerCase().includes(query);

    const connectionIds = new Set(data.connections.map((connection) => connection.connectionId));
    const allConnections = data.connections.map(presentConnectionRow);

    const allFound: ProviderCollectionFoundRow[] = [];
    if (input.localDiscoveryEnabled) {
        for (const candidate of data.discoveryCandidates) {
            if (candidate.connection.status === 'matched' && connectionIds.has(candidate.connection.connectionId)) continue;
            allFound.push({
                kind: 'candidate',
                key: `candidate:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`,
                pendingKey: providerCandidatePendingKey(candidate),
                title: candidate.providerName,
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
                installation,
            });
        }
    }

    return {
        connections: allConnections.filter((row) => matches(row.title, row.provenance)),
        found: allFound.filter((row) => matches(row.title)),
        total: allConnections.length + allFound.length,
    };
}

/**
 * The connection a wide collection opens when its route names none: the last one visited in this
 * app session if it still exists, else the first. `null` when there is nothing to open.
 */
export function resolveProviderCollectionLandingId(
    connections: readonly Pick<ProviderCollectionConnectionRow, 'connectionId'>[],
    lastVisited: string | null,
): string | null {
    return resolveHappierCollectionInitialKey({ keys: connections.map((row) => row.connectionId), lastVisited });
}

const providerVisits = createHappierCollectionVisitMemory<string>();

export const recordProviderCollectionVisit = providerVisits.record;
export const readLastVisitedProviderConnectionId = providerVisits.read;

/** The query value that opens a connection's detail on its Models section. */
export const PROVIDER_CONNECTION_MODELS_SECTION = 'models';

/**
 * A connection's models live in its detail page. Links to them open the detail on the Models
 * section, optionally with the manual-model editor open.
 */
export function providerConnectionModelsRoute(connectionId: string, options: Readonly<{ add?: boolean }> = {}): string {
    const add = options.add ? '&add=1' : '';
    return `/(app)/settings/providers/${encodeURIComponent(connectionId)}?section=${PROVIDER_CONNECTION_MODELS_SECTION}${add}`;
}
