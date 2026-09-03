import {
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import type { CodexConnectedServiceRefreshSelection } from './authApplication/types';

export type CodexConnectedServiceRuntimeAuthExpected = Readonly<{
  profileId?: string;
  groupId?: string;
  generation?: string | number;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}>;

export type CodexConnectedServiceRuntimeAuthApplyRequest = Readonly<{
  serviceId: 'openai-codex';
  candidate: ConnectedServiceCredentialRecordV1;
  forcedWorkspaceId?: string | null;
  forcedLoginMethod?: string | null;
  selection?: CodexConnectedServiceRefreshSelection | null;
  expected?: CodexConnectedServiceRuntimeAuthExpected | null;
  reason?: string | null;
}>;

export type CodexConnectedServiceRuntimeAuthApplyBuildInput = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selection?: Record<string, unknown> | null;
  reason?: string | null;
  forcedWorkspaceId?: string | null;
  forcedLoginMethod?: string | null;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readProtocolGeneration(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return readString(value) ?? undefined;
}

export function readCodexConnectedServiceRuntimeAuthExpected(value: unknown): CodexConnectedServiceRuntimeAuthExpected | null {
  const record = readRecord(value);
  if (!record) return null;
  const profileId = readString(record.profileId);
  const groupId = readString(record.groupId);
  const generation = readProtocolGeneration(record.generation);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(record.credentialRevision);
  if (!profileId && !groupId && generation === undefined && !credentialRevision.success) return null;
  return {
    ...(profileId ? { profileId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(generation === undefined ? {} : { generation }),
    ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
  };
}

function readApplyReason(value: unknown): 'usage_limit' | 'same_provider_account_exhausted' | 'soft_threshold' | 'manual' | 'diagnostic' {
  return value === 'usage_limit'
    || value === 'same_provider_account_exhausted'
    || value === 'soft_threshold'
    || value === 'manual'
    || value === 'diagnostic'
    ? value
    : 'manual';
}

function buildRuntimeApplyExpected(
  selection: Record<string, unknown> | null,
  record: ConnectedServiceCredentialRecordV1,
): Record<string, unknown> {
  const expected: Record<string, unknown> = { profileId: readString(selection?.activeProfileId ?? selection?.profileId) ?? record.profileId };
  const groupId = readString(selection?.groupId);
  if (groupId) expected.groupId = groupId;
  const generation = readNonNegativeInteger(selection?.generation);
  if (generation !== null) expected.generation = generation;
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection?.credentialRevision);
  if (credentialRevision.success) expected.credentialRevision = credentialRevision.data;
  return expected;
}

function buildRuntimeApplySelection(
  selection: Record<string, unknown> | null,
  record: ConnectedServiceCredentialRecordV1,
): CodexConnectedServiceRefreshSelection {
  const groupId = readString(selection?.groupId);
  if (groupId) {
    const activeProfileId = readString(selection?.activeProfileId ?? selection?.profileId) ?? record.profileId;
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId,
      activeProfileId,
      ...(readString(selection?.fallbackProfileId) ? { fallbackProfileId: readString(selection?.fallbackProfileId) } : {}),
      generation: readNonNegativeInteger(selection?.generation) ?? 0,
    };
  }
  return {
    kind: 'profile',
    serviceId: 'openai-codex',
    profileId: readString(selection?.profileId) ?? record.profileId,
  };
}

export function buildCodexConnectedServiceRuntimeAuthApplyRequest(
  input: CodexConnectedServiceRuntimeAuthApplyBuildInput,
): Record<string, unknown> {
  const selection = input.selection ?? null;
  const forcedWorkspaceId = readString(input.forcedWorkspaceId);
  const forcedLoginMethod = readString(input.forcedLoginMethod) ?? readString(selection?.forcedLoginMethod);
  return {
    serviceId: 'openai-codex',
    reason: readApplyReason(input.reason ?? selection?.applyReason),
    expected: buildRuntimeApplyExpected(selection, input.record),
    authGeneration: {
      credential: input.record,
      selection: buildRuntimeApplySelection(selection, input.record),
      ...(forcedWorkspaceId ? { forcedWorkspaceId } : {}),
      ...(forcedLoginMethod ? { forcedLoginMethod } : {}),
    },
  };
}

function normalizeCodexConnectedServiceRefreshSelection(value: unknown): CodexConnectedServiceRefreshSelection | null {
  const record = readRecord(value);
  if (!record || record.serviceId !== 'openai-codex') return null;
  if (record.kind === 'profile') {
    const profileId = readString(record.profileId);
    return profileId
      ? {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId,
        }
      : null;
  }
  if (record.kind === 'group') {
    const groupId = readString(record.groupId);
    const activeProfileId = readString(record.activeProfileId);
    const generation = readNonNegativeInteger(record.generation);
    if (!groupId || !activeProfileId || generation === null) return null;
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId,
      activeProfileId,
      ...(readString(record.fallbackProfileId) ? { fallbackProfileId: readString(record.fallbackProfileId) } : {}),
      generation,
    };
  }
  return null;
}

function normalizeCodexConnectedServiceRefreshSelectionFromExpected(
  expected: CodexConnectedServiceRuntimeAuthExpected | null,
): CodexConnectedServiceRefreshSelection | null {
  if (!expected?.profileId) return null;
  if (expected.groupId) {
    const generation = readNonNegativeInteger(expected.generation);
    if (generation === null) return null;
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: expected.groupId,
      activeProfileId: expected.profileId,
      generation,
    };
  }
  return {
    kind: 'profile',
    serviceId: 'openai-codex',
    profileId: expected.profileId,
  };
}

export function parseCodexConnectedServiceRuntimeAuthApplyRequest(
  value: unknown,
): CodexConnectedServiceRuntimeAuthApplyRequest | null {
  const record = readRecord(value);
  if (!record || record.serviceId !== 'openai-codex') return null;
  const authGeneration = readRecord(record.authGeneration);
  const source = authGeneration ?? record;
  const parsedCredential = ConnectedServiceCredentialRecordV1Schema.safeParse(
    source.candidate
    ?? source.record
    ?? source.credential
    ?? record.candidate
    ?? record.record
    ?? record.credential,
  );
  if (!parsedCredential.success) return null;
  const expected = readCodexConnectedServiceRuntimeAuthExpected(record.expected);
  const selection = normalizeCodexConnectedServiceRefreshSelection(source.selection ?? record.selection)
    ?? normalizeCodexConnectedServiceRefreshSelectionFromExpected(expected);
  return {
    serviceId: 'openai-codex',
    candidate: parsedCredential.data,
    forcedWorkspaceId: readString(source.forcedWorkspaceId ?? record.forcedWorkspaceId),
    forcedLoginMethod: readString(source.forcedLoginMethod ?? record.forcedLoginMethod),
    selection,
    expected,
    reason: readString(record.reason),
  };
}
