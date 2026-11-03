import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedAccountMaterializationRequest } from '@happier-dev/protocol/connect/connected-account-purposes';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

export type ConnectedAccountPurposeMaterializationInput = Readonly<{
  account: QualifiedConnectedAccountRef;
  expectedConfigurationRevision?: string | null;
  credentialRevisionBasis?: Readonly<{
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    captureCredentialRevision(revision: ConnectedServiceCredentialRevisionV1): void;
  }>;
  request: ConnectedAccountMaterializationRequest;
  /** Host-private redaction classification, never a plugin materialization option. */
  observeMaterializationPublicValues?: (values: readonly string[]) => void;
  existingFiles?: Readonly<Record<string, Uint8Array>>;
  signal: AbortSignal;
}>;

/** The established owner, not a raw credential reader, supplies this receipt. */
export type ConnectedAccountPurposeMaterializationOwner<TMaterial> = Readonly<{
  invokeWithReceipt(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedConfigurationRevision?: string | null;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    operation: Readonly<{ kind: 'materialize'; request: ConnectedAccountMaterializationRequest;
      existingFiles?: Readonly<Record<string, Uint8Array>> }>;
    signal: AbortSignal;
  }>): Promise<Readonly<{ result: TMaterial; basis: Readonly<{
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    materializationPublicValues?: readonly string[];
  }> }>>;
}>;

/** Shared daemon/Account bridge to the incumbent provider runtime.materialize. */
export function createConnectedAccountPurposeMaterializer<TMaterial>(owner: ConnectedAccountPurposeMaterializationOwner<TMaterial>) {
  return async (input: ConnectedAccountPurposeMaterializationInput): Promise<TMaterial> => {
    input.signal.throwIfAborted();
    const receipt = await owner.invokeWithReceipt({
      account: input.account,
      ...(input.expectedConfigurationRevision !== undefined ? { expectedConfigurationRevision: input.expectedConfigurationRevision } : {}),
      operation: Object.freeze({ kind: 'materialize', request: input.request,
        ...(input.existingFiles ? { existingFiles: input.existingFiles } : {}) }),
      ...(input.credentialRevisionBasis?.expectedCredentialRevision
        ? { expectedCredentialRevision: input.credentialRevisionBasis.expectedCredentialRevision } : {}),
      signal: input.signal,
    });
    input.credentialRevisionBasis?.captureCredentialRevision(receipt.basis.credentialRevision);
    if (receipt.basis.materializationPublicValues) input.observeMaterializationPublicValues?.(receipt.basis.materializationPublicValues);
    return receipt.result;
  };
}
