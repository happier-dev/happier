import type {
    BrowserDiagnosticEventKindV1,
    BrowserDiagnosticEventV1,
    BrowserDiagnosticFamilyV1,
    BrowserDiagnosticFidelityV1} from '@happier-dev/protocol/browser/diagnostics/v1';
import type {
    PeerMediationObservabilityLifecycleStateV1,
} from '@happier-dev/protocol/machines/peer/mediation/observability/v1';

export type BrowserPreviewProxyDiagnosticsStatus = 'available' | 'stale' | 'unavailable';
export type BrowserDiagnosticsStatus = BrowserPreviewProxyDiagnosticsStatus;

export type BrowserDiagnosticFamilyProjection = Readonly<{
    family: BrowserDiagnosticFamilyV1;
    status: BrowserDiagnosticsStatus;
    fidelity: BrowserDiagnosticFidelityV1;
    trusted: boolean;
    reasonCode?: string;
}>;

/**
 * A single typed scalar field carried by a diagnostics event projection. The `key` is the canonical
 * (devtools) field identifier sanitized into the event `data` (e.g. `method`, `statusCode`,
 * `durationMs`); the `value` is the already-sanitized scalar. Panels render these as labeled rows /
 * table columns so the LOCAL owner sees real per-family data instead of one collapsed summary string
 * (DEV-1 / root-cause: `BrowserDiagnosticEventProjection` previously collapsed to `summary?:string`).
 */
export type BrowserDiagnosticEventField = Readonly<{
    key: string;
    value: string | number | boolean;
}>;

/**
 * One inventoried resource-timing entry (from `resources.snapshot`). Only the allowlisted structural
 * fields survive sanitization — never response bodies or query values.
 */
export type BrowserDiagnosticResourceEntry = Readonly<{
    name?: string;
    initiatorType?: string;
    durationMs?: number;
}>;

export type BrowserDiagnosticStorageEntry = Readonly<{
    key: string;
    value: string;
    valueTruncated?: boolean;
}>;

/**
 * Typed, family-specific projection of an event's sanitized `data`. Consumed by the family panel
 * bodies (Network request table + detail, Elements attributes, Storage/Resources key/value tables,
 * Performance vitals). `fields` are ordered scalar rows; `keys` carries a `storage.keyInventory`
 * key list; `entries` carries `resources.snapshot` rows.
 */
export type BrowserDiagnosticEventDetail = Readonly<{
    fields: readonly BrowserDiagnosticEventField[];
    keys?: readonly string[];
    entries?: readonly BrowserDiagnosticResourceEntry[];
    storageEntries?: readonly BrowserDiagnosticStorageEntry[];
}>;

export type BrowserDiagnosticEventProjection = Readonly<{
    eventId: string;
    family: BrowserDiagnosticFamilyV1;
    kind: BrowserDiagnosticEventKindV1;
    fidelity: BrowserDiagnosticFidelityV1;
    trusted: boolean;
    capturedAtMs: number;
    redaction?: BrowserDiagnosticEventV1['redaction'];
    summary?: string;
    detail?: BrowserDiagnosticEventDetail;
    /** The admitted destination projection, including structured source/stack/network details. */
    data?: Readonly<Record<string, unknown>>;
}>;

export type BrowserDiagnosticRequestProjection = Readonly<{
    key: string;
    requestId: string | null;
    kind: 'http' | 'socket' | 'beacon';
    events: readonly BrowserDiagnosticEventProjection[];
    start?: BrowserDiagnosticEventProjection;
    response?: BrowserDiagnosticEventProjection;
    finished?: BrowserDiagnosticEventProjection;
    failure?: BrowserDiagnosticEventProjection;
    method: string | null;
    url: string | null;
    status: number | null;
    /** Transport failure; HTTP error responses retain their status for display. */
    failed: boolean;
    /** The store's failed-only classification: transport failure or HTTP status >= 400. */
    isFailure: boolean;
    errorText: string | null;
    durationMs: number | null;
    sizeBytes: number | null;
    type: string | null;
    state: string | null;
}>;

export type BrowserDiagnosticStorageRow = Readonly<{
    key: string;
    storageType: string;
    name: string;
    value: string | null;
    valueTruncated: boolean;
    keyCount: number;
    keysTruncated: boolean;
}>;

export type BrowserDiagnosticResourceRow = Readonly<{
    key: string;
    entry: BrowserDiagnosticResourceEntry;
}>;

export type BrowserDiagnosticsSnapshotState = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    connection: 'connecting' | 'connected' | 'disconnected';
    reasonCode?: string;
    evictedEventCount?: number;
    omittedEventCount?: number;
}>;

export type BrowserDiagnosticsViewState = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    events: readonly BrowserDiagnosticEventV1[];
    updatedAtMs: number;
    snapshotState?: BrowserDiagnosticsSnapshotState;
}>;

export type BrowserDiagnosticsUiStore = Readonly<{
    viewsByKey: Readonly<Record<string, BrowserDiagnosticsViewState>>;
}>;

export type BrowserViewDiagnosticsProjection = Readonly<{
    status: BrowserDiagnosticsStatus;
    sourceKind: 'browserDiagnostics';
    browserSessionId: string;
    viewId: string;
    navigationGeneration?: number;
    fidelity: BrowserDiagnosticFidelityV1;
    trusted: boolean;
    eventCount: number;
    families: readonly BrowserDiagnosticFamilyProjection[];
    events: readonly BrowserDiagnosticEventProjection[];
    connection?: BrowserDiagnosticsSnapshotState['connection'];
    reasonCode?: string;
    evictedEventCount?: number;
    omittedEventCount?: number;
}>;

export type BrowserPreviewProxyFlowProjection = Readonly<{
    flowId: string;
    family: 'network' | 'proxyTunnel';
    fidelity: 'previewProxy';
    trusted: true;
    lifecycleState: PeerMediationObservabilityLifecycleStateV1;
    method?: string;
    path?: string;
    statusCode?: number;
    websocketSubprotocol?: string;
    bytesIn: number;
    bytesOut: number;
    messagesIn: number;
    messagesOut: number;
    activeSubstreams: number;
    movingThroughputBps?: number;
    closeReasonCode?: string;
    abortReasonCode?: string;
    errorReasonCode?: string;
    lastActivityAtMs: number;
}>;

export type BrowserPreviewProxyDiagnosticsProjection = Readonly<{
    status: BrowserPreviewProxyDiagnosticsStatus;
    sourceKind: 'previewProxy';
    fidelity: BrowserDiagnosticFidelityV1;
    trusted: true;
    attribution: 'traffic_for_preview_all_views';
    unavailableReasonCode?: string;
    activeFlowCount: number;
    families: readonly BrowserDiagnosticFamilyProjection[];
    flows: readonly BrowserPreviewProxyFlowProjection[];
}>;

export type BrowserDiagnosticsPanelProjection =
    | BrowserPreviewProxyDiagnosticsProjection
    | BrowserViewDiagnosticsProjection;
