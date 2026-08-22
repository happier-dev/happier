import {
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  resolveExternalHistoryImportV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
  type ExternalSessionsAgentId,
  type ExternalSessionStorageStateV1,
} from '@happier-dev/protocol';

export type HostedExternalSessionIdentityProof =
  | Readonly<{ state: 'matched' | 'not_matched' }>
  | Readonly<{
      state: 'conflict';
      error:
        | 'external_history_import_invalid'
        | 'linked_session_invalid'
        | 'linked_session_reconciliation_required';
    }>;

export function resolveHostedExternalSessionIdentityProof(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  currentStorageState: ExternalSessionStorageStateV1 | undefined;
  currentStorageStateWasOmitted: boolean;
  expected: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
  }>;
}>): HostedExternalSessionIdentityProof {
  const historyImport = resolveExternalHistoryImportV1FromMetadata(
    params.metadata,
  );
  if (historyImport.state === 'invalid') {
    return { state: 'conflict', error: historyImport.error };
  }

  // Stable server-v0.2.1 and its prospective predecessor omitted this field
  // before non-hosted storage states existed. Current servers persist it.
  const storageProvesHosted =
    params.currentStorageState === 'hosted'
    || (
      params.currentStorageStateWasOmitted
      && params.currentStorageState === undefined
    );
  if (
    !storageProvesHosted
    || historyImport.state === 'valid'
    || params.metadata.machineId !== params.expected.machineId
    || resolveAgentIdFromSessionMetadata(params.metadata)
      !== params.expected.agentId
    || resolveVendorResumeIdFromSessionMetadata(
      params.expected.agentId,
      params.metadata,
    ) !== params.expected.remoteSessionId
  ) {
    return { state: 'not_matched' };
  }

  const linked = resolveLinkedExternalSessionMetadataV1(params.metadata);
  if (linked.ok) return { state: 'not_matched' };
  if (linked.error === 'linked_session_not_found') return { state: 'matched' };
  return { state: 'conflict', error: linked.error };
}

export function metadataProvesHostedExternalSessionIdentity(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  currentStorageState: ExternalSessionStorageStateV1 | undefined;
  currentStorageStateWasOmitted: boolean;
  expected: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
  }>;
}>): boolean {
  return resolveHostedExternalSessionIdentityProof(params).state === 'matched';
}
