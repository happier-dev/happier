import type {
    OauthCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { parseCredentialRecord } from '@happier-dev/plugin-sdk/connected-accounts';

import type { CodexConnectedServiceRefreshSelection } from './application.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export type CodexConnectedServiceAuthGenerationRequest = Readonly<{
  serviceId: 'openai-codex';
  credential: OauthCredentialRecord;
  credentialRevision: string | null;
  forcedWorkspaceId: string | null;
  forcedLoginMethod: string | null;
  selection: CodexConnectedServiceRefreshSelection | null;
  expected: Readonly<{
    profileId: string | null;
    groupId: string | null;
    generation: number | null;
    credentialRevision?: string | null;
  }>;
}>;

function readCodexOauthCredentialRecord(value: unknown): OauthCredentialRecord | null {
  const record = parseCredentialRecord(value);
  if (!record || record.kind !== 'oauth' || record.serviceId !== 'openai-codex') return null;
  return record;
}

function readCodexRefreshSelection(value: unknown): CodexConnectedServiceRefreshSelection | null {
  const record = readRecord(value);
  if (!record || record.serviceId !== 'openai-codex') return null;
  const kind = readString(record.kind);
  if (kind === 'profile') {
    const profileId = readString(record.profileId);
    return profileId
      ? { kind: 'profile', serviceId: 'openai-codex', profileId }
      : null;
  }
  if (kind === 'group') {
    const groupId = readString(record.groupId);
    const activeProfileId = readString(record.activeProfileId);
    const generation = typeof record.generation === 'number' && Number.isFinite(record.generation)
      ? Math.trunc(record.generation)
      : null;
    if (!groupId || !activeProfileId || generation === null) return null;
    const fallbackProfileId = readString(record.fallbackProfileId);
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId,
      activeProfileId,
      ...(fallbackProfileId ? { fallbackProfileId } : {}),
      generation,
    };
  }
  return null;
}

export function readCodexConnectedServiceExpected(value: unknown): CodexConnectedServiceAuthGenerationRequest['expected'] {
  const record = readRecord(value);
  const generation = typeof record?.generation === 'number' && Number.isFinite(record.generation)
    ? Math.trunc(record.generation)
    : null;
  return {
    profileId: readString(record?.profileId),
    groupId: readString(record?.groupId),
    generation,
    credentialRevision: readString(record?.credentialRevision),
  };
}

export function normalizeCodexConnectedServiceAuthGenerationRequest(
  value: unknown,
): CodexConnectedServiceAuthGenerationRequest | null {
  const record = readRecord(value);
  if (record?.serviceId !== 'openai-codex') return null;
  const generation = readRecord(record.authGeneration);
  const credential = readCodexOauthCredentialRecord(generation?.credential);
  if (!generation || !credential) return null;
  return {
    serviceId: 'openai-codex',
    credential,
    credentialRevision: readString(generation.credentialRevision),
    forcedWorkspaceId: readString(generation.forcedWorkspaceId),
    forcedLoginMethod: readString(generation.forcedLoginMethod),
    selection: readCodexRefreshSelection(generation.selection),
    expected: readCodexConnectedServiceExpected(record.expected),
  };
}

export function resolveCodexAppliedProfileId(input: Readonly<{
  credential: OauthCredentialRecord;
  selection: CodexConnectedServiceRefreshSelection | null;
  expected: CodexConnectedServiceAuthGenerationRequest['expected'];
}>): string {
  if (input.selection?.kind === 'group') return input.selection.activeProfileId;
  if (input.selection?.kind === 'profile') return input.selection.profileId;
  return input.expected.profileId ?? input.credential.profileId;
}

export function resolveCodexAppliedGroupId(input: Readonly<{
  selection: CodexConnectedServiceRefreshSelection | null;
  expected: CodexConnectedServiceAuthGenerationRequest['expected'];
}>): string | null {
  if (input.selection?.kind === 'group') return input.selection.groupId;
  return input.expected.groupId;
}

export function resolveCodexAppliedGeneration(input: Readonly<{
  selection: CodexConnectedServiceRefreshSelection | null;
  expected: CodexConnectedServiceAuthGenerationRequest['expected'];
}>): number | null {
  if (input.selection?.kind === 'group') return input.selection.generation;
  return input.expected.generation;
}
