/** @moduleRealm daemon */
import type {
    DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseTargetsListInputV1, DatabaseTargetsListResultV1,
} from '@happier-dev/database-protocol';
import type { DeploymentDatabaseResolutionV1 } from '../deploymentTargets.js';
import type { DeploymentTelemetryAssignmentsV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';

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
export type DeploymentTelemetryAssignmentV1 = Readonly<DeploymentTelemetryAssignmentsV1['assignments'][number]>;

/** Same daemon's production collector, bound to its captured Account and Machine. */
export interface DeploymentTelemetryServiceV1 {
    readAssignments(options?: Readonly<{ signal?: AbortSignal }>): Promise<readonly DeploymentTelemetryAssignmentV1[]>;
    subscribeAssignmentsChanged(refresh: () => Promise<void>): () => void;
    /** Runtime-only endpoint getter; launch never reads assignments or starts another listener. */
    exposeEndpoint(read: () => string | null): () => void;
}

/** Uses the existing deployment selection, admission and connection-custody owner. */
export interface DeploymentDatabasesServiceV1 {
    listTargets(input: DatabaseTargetsListInputV1): Promise<DatabaseTargetsListResultV1>;
    resolve(input: DatabaseOperationInputV1, access: DatabaseOperationClassV1): Promise<DeploymentDatabaseResolutionV1>;
}
