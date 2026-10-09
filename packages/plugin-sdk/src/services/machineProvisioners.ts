/** @moduleRealm daemon */

/** Private material for the host-admitted managed resource, never an Action input. */
export type MachineProvisionerBootstrapCredentialLeaseV1 =
    | Readonly<{ kind: 'bytes'; bytes: Uint8Array; dispose(): Promise<void> }>
    | Readonly<{ kind: 'file'; path: string; dispose(): Promise<void> }>;

export interface MachineProvisionersService {
    /**
     * Temporarily deliver the admitted SSH key and its derived .pub sibling at
     * a native-required plugin-relative path. The host serializes publication,
     * the callback and file-only cleanup; native claim directories are retained.
     */
    withBootstrapCredentialFile<TResult>(request: Readonly<{ relativePath: string }>,
        effect: (lease: Extract<MachineProvisionerBootstrapCredentialLeaseV1, { kind: 'file' }>) => Promise<TResult>): Promise<TResult>;
    /**
     * Materialize only the credential retained by this managed-resource invocation.
     * The host also disposes the lease when the invocation settles.
     */
    materializeBootstrapCredential(request: Readonly<{ kind: 'bytes' | 'file' }>):
        Promise<MachineProvisionerBootstrapCredentialLeaseV1>;
}
