/** @moduleRealm daemon */

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
