/** @moduleRealm any */

/** Private material for the host-admitted managed resource, never an Action input. */
export type MachineProvisionerBootstrapCredentialLeaseV1 =
    | Readonly<{ kind: 'bytes'; bytes: Uint8Array; dispose(): Promise<void> }>
    | Readonly<{ kind: 'file'; path: string; dispose(): Promise<void> }>;

/** Invocation-private material; never an Action operand, result or retained fact. */
export type MachineProvisionerNativeCredentialHeadersResultV1 =
    | Readonly<{ ok: true; headers: Readonly<Record<string, string>> }>
    | Readonly<{ ok: false; code: 'native_credential_binding_unavailable' }>;

export interface MachineProvisionersService {
    /**
     * Open only this SSH acquire installer's generated guest-host private key.
     * It is distinct from the bootstrap user key. The host retains redaction
     * and zeroes the byte lease on disposal or invocation settlement.
     */
    materializeGuestHostCredential(): Promise<Extract<MachineProvisionerBootstrapCredentialLeaseV1, { kind: 'bytes' }>>;
    /**
     * Render headers only for a binding already admitted to this native apply
     * invocation. Unknown bindings and ordinary invocations return refusal.
     * There is no credential selector and the host retains redaction custody.
     */
    materializeNativeCredentialHeaders(request: Readonly<{ bindingKey: string }>):
        Promise<MachineProvisionerNativeCredentialHeadersResultV1>;

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
