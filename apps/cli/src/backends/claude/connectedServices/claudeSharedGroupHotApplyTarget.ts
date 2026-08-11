import {
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import type { ClaudeSubscriptionNativeAuthSelectionDescriptor } from './nativeAuth/materializeClaudeCodeNativeAuth';
import {
  isHealthyClaudeSubscriptionNativeAuthCredentialRecord,
  type ClaudeSubscriptionNativeAuthCredentialRecord,
} from './nativeAuth/claudeCodeCredentialHealth';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import {
  readClaudeRuntimeAuthSharedGroupSurfaceMetadata,
  type ClaudeRuntimeAuthSharedGroupSurfaceMetadata,
} from './claudeRuntimeAuthSharedGroupSurfaceMetadata';

export type ClaudeSharedGroupHotApplyTarget = Readonly<{
  record: ClaudeSubscriptionNativeAuthCredentialRecord;
  metadata: ClaudeRuntimeAuthSharedGroupSurfaceMetadata;
  selectionDescriptor: Extract<ClaudeSubscriptionNativeAuthSelectionDescriptor, { kind: 'group' }>;
  credentialRevision: ConnectedServiceCredentialRevisionV1;
  validateCurrentBeforeMutation?: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function readClaudeSubscriptionNativeAuthRecord(
  value: unknown,
): ClaudeSubscriptionNativeAuthCredentialRecord | null {
  const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return isHealthyClaudeSubscriptionNativeAuthCredentialRecord(parsed.data)
    ? parsed.data
    : null;
}

export function resolveClaudeSharedGroupHotApplyTarget(
  selection: unknown,
): ClaudeSharedGroupHotApplyTarget | null {
  const selectionRecord = readRecord(selection);
  if (!selectionRecord) return null;
  const serviceId = readString(selectionRecord.serviceId);
  if (serviceId !== null && serviceId !== 'claude-subscription') return null;
  const record = readClaudeSubscriptionNativeAuthRecord(selectionRecord.record);
  const metadata = readClaudeRuntimeAuthSharedGroupSurfaceMetadata(selection);
  const groupId = readString(selectionRecord.groupId);
  const activeProfileId = readString(selectionRecord.activeProfileId);
  const generation = readNumber(selectionRecord.generation);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selectionRecord.credentialRevision);
  if (!record || !metadata || !groupId || !activeProfileId || generation === null || !credentialRevision.success) return null;
  return {
    record,
    metadata,
    credentialRevision: credentialRevision.data,
    selectionDescriptor: {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId,
      activeProfileId,
      fallbackProfileId: readString(selectionRecord.fallbackProfileId) ?? activeProfileId,
      generation,
    },
  };
}
