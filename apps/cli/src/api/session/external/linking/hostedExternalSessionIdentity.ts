import {
  isAgentId,
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionsAgentId,
  type ExternalSessionStorageStateV1,
} from '@happier-dev/protocol';

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
  if (!isAgentId(params.expected.agentId)) return false;

  // Stable server-v0.2.1 and its prospective predecessor omitted this field
  // before non-hosted storage states existed. Current servers persist it.
  const storageProvesHosted =
    params.currentStorageState === 'hosted'
    || (
      params.currentStorageStateWasOmitted
      && params.currentStorageState === undefined
    );

  return storageProvesHosted
    && !readLinkedExternalSessionV1FromMetadata(params.metadata)
    && !readExternalHistoryImportV1FromMetadata(params.metadata)
    && params.metadata.machineId === params.expected.machineId
    && resolveAgentIdFromSessionMetadata(params.metadata)
      === params.expected.agentId
    && resolveVendorResumeIdFromSessionMetadata(
      params.expected.agentId,
      params.metadata,
    ) === params.expected.remoteSessionId;
}
