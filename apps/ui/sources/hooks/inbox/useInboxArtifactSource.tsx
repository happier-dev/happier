import * as React from 'react';

import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { countInboxArtifactRows, projectInboxArtifactItems, type InboxArtifactItems } from '@/sync/domains/artifacts/inboxArtifacts';
import { BADGE_COUNT_MAX } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { storage, useArtifactsLoaded, useInboxArtifactBodyHydration } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export type InboxArtifactSource = Readonly<{ scope: ServerAccountScope | null; phase: 'loading' | 'current' | 'partial' | 'failed'; retry: () => void }>;
const SourceContext = React.createContext<InboxArtifactSource | null>(null);
const ItemsContext = React.createContext<InboxArtifactItems | null>(null);
const OpenCountContext = React.createContext<number | null>(null);
/** Registers one presenting consumer of approval bodies; returns its release. */
const BodyDemandContext = React.createContext<(() => () => void) | null>(null);
/** Registers one consumer of Inbox rows (lists, grouping, notices); returns its release. */
const RowDemandContext = React.createContext<(() => () => void) | null>(null);
const NO_ARTIFACTS: Readonly<Record<string, DecryptedArtifact>> = Object.freeze({});

function SourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const presented = useLayoutPresentationActive();
    const order = storage(state => state.artifactInboxOrder);
    const incomplete = storage(state => state.artifactIncompleteInboxArtifacts);
    const scope = storage(state => state.profileScope);
    // A page that changes no list member republishes none of the lists (nor the value when nothing moved).
    const published = React.useRef<InboxArtifactItems | null>(null);
    const items = React.useMemo(() => {
        published.current = projectInboxArtifactItems(order, scope?.accountId, published.current);
        return published.current;
    }, [order, scope?.accountId]);
    const exhausted = useArtifactsLoaded('inboxOpen');
    const loaded = storage(state => state.isDataReady && isArtifactInventoryLoaded(state, 'inboxOpen'));
    // A count-only shell (the badge shows at most 99+) reads the census only until this read has seen
    // more counted rows than a badge shows. Every row consumer reads the full census while mounted.
    const [rowDemand, setRowDemand] = React.useState(0);
    // Rows stay wanted from a row consumer's first mount until a complete census, so a consumer that
    // remounts mid-read extends that read instead of ending it at a window. The ref is what an
    // unfinished census reads at each page; the window itself stays one stable consumer.
    const [rowsWanted, setRowsWanted] = React.useState(false);
    const rowsWantedNow = React.useRef(false);
    const demandRows = React.useCallback(() => {
        rowsWantedNow.current = true;
        setRowsWanted(true);
        setRowDemand(value => value + 1);
        return () => setRowDemand(value => value - 1);
    }, []);
    React.useLayoutEffect(() => {
        if (!exhausted || rowDemand > 0) return;
        rowsWantedNow.current = false;
        setRowsWanted(false);
    }, [exhausted, rowDemand]);
    const accountId = scope?.accountId;
    const countWindow = React.useMemo(() => ({ window: (read: readonly DecryptedArtifact[]) =>
        !rowsWantedNow.current && countInboxArtifactRows(read, accountId) > BADGE_COUNT_MAX }), [accountId]);
    const windowSatisfied = !rowsWanted && !exhausted && items.count > BADGE_COUNT_MAX;
    const inventory = useArtifactInventoryRead(!exhausted && !windowSatisfied, 'inboxOpen', countWindow);
    // The count reads header facts. Approval bodies are read only while a presenting consumer is mounted.
    const [bodyDemand, setBodyDemand] = React.useState(0);
    const demandBodies = React.useCallback(() => {
        setBodyDemand(value => value + 1);
        return () => setBodyDemand(value => value - 1);
    }, []);
    const presenting = bodyDemand > 0;
    const bodies = useInboxArtifactBodyHydration(presented ? incomplete : NO_ARTIFACTS, scope?.serverId, scope?.accountId, presenting);
    const phase: InboxArtifactSource['phase'] = inventory.failed || bodies.failed ? 'failed'
        // The badge's count is certified past its 99+ limit by the leading census window.
        : windowSatisfied && !bodies.pending ? 'current'
        : !exhausted || bodies.pending ? 'loading'
        : loaded && items.complete && (!presenting || items.unreadApprovalBodies === 0) ? 'current' : 'partial';
    const retry = React.useCallback(() => { inventory.retry(); bodies.retry(); }, [inventory.retry, bodies.retry]);
    const source = React.useMemo(() => ({ scope, phase, retry }), [scope, phase, retry]);
    return <SourceContext.Provider value={source}><OpenCountContext.Provider value={items.count}>
        <RowDemandContext.Provider value={demandRows}><BodyDemandContext.Provider value={demandBodies}>
            <ItemsContext.Provider value={items}>{props.children}</ItemsContext.Provider>
        </BodyDemandContext.Provider></RowDemandContext.Provider>
    </OpenCountContext.Provider></SourceContext.Provider>;
}

/**
 * A consumer that presents approval rows (their request, grouping or quick actions) demands their
 * bodies while mounted. Count-only readers never call this, so a cold shell reads no approval body.
 * Outside a source boundary no source hydrates, so there is nothing to demand.
 */
export function useInboxArtifactBodyDemand(active = true): void {
    useInboxArtifactRowDemand(active);
    const demand = React.useContext(BodyDemandContext);
    React.useLayoutEffect(() => active && demand ? demand() : undefined, [demand, active]);
}

/**
 * A consumer of Inbox rows (lists, grouping, notices) reads the full Inbox census while mounted.
 * `useInboxArtifactItems` and `useInboxArtifactBodyDemand` register it; a consumer that reads the
 * store's Inbox projections directly calls this. The count-only shell never does.
 */
export function useInboxArtifactRowDemand(active = true): void {
    const demand = React.useContext(RowDemandContext);
    React.useLayoutEffect(() => active && demand ? demand() : undefined, [demand, active]);
}

/** The shell summary and its open model share one mounted inventory/body demand. */
export function InboxArtifactSourceBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(SourceContext);
    return existing ? <>{props.children}</> : <SourceProvider>{props.children}</SourceProvider>;
}
export function useInboxArtifactSource(): InboxArtifactSource {
    const source = useOptionalInboxArtifactSource();
    if (!source) throw new Error('Inbox Artifact source boundary is required');
    return source;
}

/** A standalone record reader can expose unavailable without acquiring another inventory. */
export function useOptionalInboxArtifactSource(): InboxArtifactSource | null {
    return React.useContext(SourceContext);
}

/** The shell badge reads only the count, so a page that moves no count renders nothing. */
export function useInboxArtifactOpenCount(): number {
    const value = React.useContext(OpenCountContext);
    if (value === null) throw new Error('Inbox Artifact source boundary is required');
    return value;
}

export function useInboxArtifactItems(): InboxArtifactItems {
    useInboxArtifactRowDemand();
    const value = React.useContext(ItemsContext);
    if (!value) throw new Error('Inbox Artifact source boundary is required');
    return value;
}
