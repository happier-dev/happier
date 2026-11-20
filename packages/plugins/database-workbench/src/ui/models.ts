import type {
    DatabaseCellResultV1,
    DatabaseCellV1,
    DatabaseDescriptorV1,
    DatabaseEditV1,
    DatabaseFailureV1,
    DatabaseFilterV1,
    DatabaseOperationInputV1,
    DatabaseOperationResultV1,
    DatabaseOrderV1,
    DatabaseRelationV1,
    DatabaseTargetV1,
    DatabaseTargetsListInputV1,
    DatabaseTargetsListResultV1,
    DatabaseValueRangeV1,
    DatabaseWriteValueV1,
    DatabaseStatementRunInputV1,
    DatabaseStatementExplainInputV1,
    DatabaseEditsApplyInputV1,
    DatabaseCompletenessV1,
    DatabaseStatsObservationV1,
} from '@happier-dev/plugin-sdk/database';
import type { DatabaseSelectedRowsExportInputV1 } from '@happier-dev/database-protocol';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { SharePrincipalPresentation } from '@happier-dev/plugin-ui/components';
import type { ConsoleDeviceStorage } from './consoleState.js';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import type { HostDatabaseActivityResource, HostDatabaseLastLook } from '@happier-dev/plugin-ui/hostApi';

/** Spread on the existing Action.Control; it contains preparation and settlement, never an executor. */
export type WorkbenchControlBinding = Readonly<{ action: string; controller: PluginUiActionControlController; signal?: AbortSignal }>;

export type WorkbenchStatus = 'loading' | 'ready' | 'empty' | 'offline' | 'stale' | 'unavailable';
export type WorkbenchLocation = Readonly<{
    targetKey: string;
    relation?: DatabaseRelationV1;
    mode: 'data' | 'structure' | 'console' | 'overview' | 'insights';
    conditions?: DatabaseFilterV1;
    sort: readonly DatabaseOrderV1[];
    columns: readonly string[];
    page: Readonly<{ rows: number; continuation?: Extract<DatabaseOperationInputV1, { operation: 'rows.read' }>['page']['continuation']; offset: number }>;
    fkTrail: readonly Readonly<{ relation: DatabaseRelationV1; conditions?: DatabaseFilterV1;
        mode?: WorkbenchLocation['mode']; sort?: WorkbenchLocation['sort']; columns?: WorkbenchLocation['columns']; page?: WorkbenchLocation['page'] }>[];
}>;
export type WorkbenchAccess = Readonly<{
    word: string;
    editing: Readonly<{ on: boolean; viewerMayChange: boolean }>;
    editors: readonly Readonly<{ principal: SharePrincipalPresentation['ref']; display: string }>[];
    agentLevel: 'none' | 'read';
    writer: 'environment' | 'machineLocal';
    environment?: Readonly<{ name: string; production: boolean }>;
}>;
export type WorkbenchTarget = Readonly<{
    targetKey: string; target: DatabaseTargetV1; name: string; engineLabel: string;
    origin: Readonly<{ variable: string; serviceName: string }> | Readonly<{ connectedBy: string }>;
    endpointLabel: string | null; relationCount: string | null; machineLabel: string | null;
}>;
export type DatabaseTargets = Readonly<{
    targets: readonly WorkbenchTarget[];
    looked: readonly Readonly<{ place: string; outcome: string }>[];
    completeness: DatabaseCompletenessV1;
}>;
export type DatabaseRelations = Readonly<{
    schemas: readonly Readonly<{ name: string; relations: readonly Readonly<{
        name: string; kind: 'table' | 'view' | 'matview'; approxRows: string | null;
    }>[] }>[];
    completeness: DatabaseCompletenessV1;
}>;
export type WorkbenchChange = Readonly<{
    targetKey: string; rowKey: string; label: string; relation: DatabaseRelationV1; change: DatabaseEditV1;
}>;
export type WorkbenchCellState =
    | Readonly<{ kind: 'unchanged' | 'inserted' | 'removed' }>
    | Readonly<{ kind: 'edited'; old: DatabaseCellV1 | undefined }>
    | Readonly<{ kind: 'refused'; message: string; constraint?: string }>;
export type WorkbenchApplyOutcome =
    | Readonly<{ kind: 'applied'; count: string; at: string }>
    | Readonly<{ kind: 'conflict'; rowKey: string; why: string }>
    | Readonly<{ kind: 'refused'; rowKey?: string; column?: string; constraint?: string; failure?: DatabaseFailureV1; code?: string; message?: string }>
    | Readonly<{ kind: 'unknown'; failure?: DatabaseFailureV1; code?: string; message?: string }>;
export type WorkbenchReview = readonly Readonly<{
    relation: DatabaseRelationV1;
    rows: readonly Readonly<{ rowKey: string; label: string; kind: DatabaseEditV1['kind'];
        changes: readonly Readonly<{ column: string; old?: DatabaseCellV1; new?: DatabaseWriteValueV1 }>[] }> [];
}>[];

/** The host/producer owns admission and transport; the instance owns only local demand and projection. */
export interface WorkbenchClient {
    /** Qualified presentation from the mounted host's Machine owner; null is unknown, never an id. */
    machineDisplayName?: import('@happier-dev/plugin-sdk/ui').PluginUiHostApi['readMachineDisplayName'];
    targets(input: DatabaseTargetsListInputV1, signal: AbortSignal): Promise<DatabaseTargetsListResultV1 & { looked?: DatabaseTargets['looked'] }>;
    operation(input: Exclude<DatabaseOperationInputV1, DatabaseStatementRunInputV1 | DatabaseStatementExplainInputV1 | DatabaseEditsApplyInputV1>, signal: AbortSignal): Promise<DatabaseOperationResultV1>;
    access(target: DatabaseTargetV1, signal: AbortSignal): Promise<WorkbenchAccess>;
    /** Existing R4 demand subscription. No second own-write channel. */
    subscribeOwnWrites(listener: (change: Readonly<{ target: DatabaseTargetV1; relation?: DatabaseRelationV1 }>) => void): () => void;
    /** Uses the existing page navigation owner; never rediscover an Environment target. */
    /** `fromRoot`: open this place as if picked from the database's root, so the host's Back has a step to it. */
    navigate(location: WorkbenchLocation, options?: Readonly<{ fromRoot?: boolean }>): Promise<void>;
    setUnsavedChanges(value: boolean): Promise<void>;
    /** Existing device-store failure presentation. */
    presentDeviceStorageError(error: unknown): void;
    /** Save file (D27 #8): the host's download owner runs the export download Action and picks the destination. */
    saveExport(input: DatabaseSelectedRowsExportInputV1, signal?: AbortSignal): Promise<FileDownloadResultV1>;
}
/** The host injects its canonical presented-demand owner; this is the resource, not a wrapper. */
export type WorkbenchActivityResource<T> = HostDatabaseActivityResource<T>;
export type WorkbenchStatementsObservation = Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }>
    | Extract<DatabaseStatsObservationV1, { status: 'unavailable' }>;
export type WorkbenchLastLook = HostDatabaseLastLook;
export type WorkbenchOptions = Readonly<{
    client: WorkbenchClient;
    scope: DatabaseTargetsListInputV1['scope'];
    location: WorkbenchLocation;
    selectedTarget?: DatabaseDescriptorV1;
    /** Derived by the producer/host's existing catalogue page demand, never a local arbitrary cap. */
    cataloguePageRows: number;
    /** Bind createConsoleDeviceStorage(hostApi, descriptor); SQL/history only. */
    consoleStorage(descriptor: DatabaseDescriptorV1): ConsoleDeviceStorage;
    /** Required when Activity is selected. Host binds createDatabaseActivityController. */
    activityResource?<T>(source: Readonly<{ read(options: Readonly<{ signal: AbortSignal }>): Promise<T> }>): WorkbenchActivityResource<T>;
    /** Host binds its device-local scoped last-look owner; never Account settings or SQL history. */
    lastLook?(target: DatabaseTargetV1): WorkbenchLastLook;
    /** P1 dialect lexer ranges. Authority never comes from SQL parsing in the UI. */
    statementRanges(sql: string, engine: string): readonly Readonly<{ start: number; end: number }>[];
}>;
export type WorkbenchCellRead = (rowKey: string, column: string, range: DatabaseValueRangeV1) => Promise<DatabaseCellResultV1>;
