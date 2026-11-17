/** @moduleRealm daemon */
import type { DeploymentTelemetryAssignmentsV1, DeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import type {
    DatabaseAccessSummaryV1, DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseTargetsListInputV1, DatabaseTargetsListResultV1,
} from '@happier-dev/database-protocol';
import type { DeploymentDatabaseResolutionV1 } from '../deploymentTargets.js';

/** Exact deployment admitted by the host's target-role invocation. No paths or source overrides. */
export type DeploymentSourceMaterializationRequestV1 = Readonly<{
    environmentId: string;
    deploymentId: string;
    expectedManifestFingerprint?: string;
}>;

/** Host-local custody of exact source. This handle is never serialized into a receipt. */
export interface DeploymentSourceMaterializationV1 {
    readonly environmentId: string;
    readonly environmentInstanceId: string;
    readonly deploymentId: string;
    readonly machineId: string;
    readonly installationId: string;
    readonly rootPath: string;
    readonly manifestFingerprint: string;
    /** Check invocation admission before commit; retained physical custody after commit. */
    assertCurrent(): Promise<void>;
    /** Settle owned staging custody, including after cancellation; never starts a workload. */
    commit(): Promise<void>;
    /** Remove only this uncommitted materialization, never a committed serving release. */
    abort(): Promise<void>;
}

/** Invocation admission chooses source, installation and destination from the approved target role. */
export interface DeploymentSourceMaterializationPortV1 {
    materialize(input: DeploymentSourceMaterializationRequestV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<DeploymentSourceMaterializationV1>;
}

/** Home-authoritative assignments contain token hashes, never raw tokens. */
export type DeploymentTelemetryAssignmentV1 = DeploymentTelemetryAssignmentsV1['assignments'][number];

/** Same daemon's production collector, bound to its captured Account and Machine. */
export interface DeploymentTelemetryServiceV1 {
    /** Explicit deployed-App listener declaration; absent on ordinary Machines. */
    readonly deployedAppPort?: number;
    readAssignments(options?: Readonly<{ signal?: AbortSignal }>): Promise<readonly DeploymentTelemetryAssignmentV1[]>;
    subscribeAssignmentsChanged(refresh: () => Promise<void>): () => void;
    /** Runtime-only endpoint getter; launch never reads assignments or starts another listener. */
    exposeEndpoint(read: () => string | null): () => void;
}

/** Uses the existing deployment selection, admission and connection-custody owner. */
export interface DeploymentDatabasesServiceV1 {
    /** Raw collector reads use this invocation's Environment data authority and selected collector,
     * independently of the Machine that runs the App. Absent on hosts without telemetry admission. */
    admitTelemetryRead?(input: Readonly<{ serverId: string; environmentId: string }>): Promise<Readonly<{
        environment: Readonly<{ serverId: string; environmentId: string; revision: number }>;
        collectorMachineId: string;
        capabilities: DeploymentTelemetryCapabilitiesV1;
    }>>;
    listTargets(input: DatabaseTargetsListInputV1): Promise<DatabaseTargetsListResultV1>;
    resolve(input: DatabaseOperationInputV1, access: DatabaseOperationClassV1): Promise<DeploymentDatabaseResolutionV1>;
    /** This request's access through the server's current Environment authorization, without a credential or
     * connection; the same decision `resolve` makes. Refusals throw their typed code. */
    admit(input: DatabaseOperationInputV1, access: DatabaseOperationClassV1): Promise<Readonly<{
        access: DatabaseAccessSummaryV1;
        environment: Readonly<{ serverId: string; environmentId: string; revision: number }>;
    }>>;
}
