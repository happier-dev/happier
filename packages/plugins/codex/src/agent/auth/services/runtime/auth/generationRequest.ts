import { join } from 'node:path';

import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/experimental/fs';
import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { buildCodexCloudAuthFile } from '../../openai/cloud/authFile.js';
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
  credential: Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  forcedWorkspaceId: string | null;
  forcedLoginMethod: string | null;
  selection: CodexConnectedServiceRefreshSelection | null;
  expected: Readonly<{
    profileId: string | null;
    groupId: string | null;
    generation: number | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>;
}>;

function readCodexOauthCredentialRecord(value: unknown): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> | null {
  const record = readRecord(value);
  if (!record || record.kind !== 'oauth' || record.serviceId !== 'openai-codex') return null;
  const oauth = readRecord(record.oauth);
  if (!oauth) return null;
  const accessToken = readString(oauth.accessToken);
  const refreshToken = readString(oauth.refreshToken);
  if (!accessToken || !refreshToken) return null;
  return record as Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>;
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
    credentialRevision: readString(record?.credentialRevision) as ConnectedServiceCredentialRevisionV1 | null,
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
    credentialRevision: readString(generation.credentialRevision) as ConnectedServiceCredentialRevisionV1 | null,
    forcedWorkspaceId: readString(generation.forcedWorkspaceId),
    forcedLoginMethod: readString(generation.forcedLoginMethod),
    selection: readCodexRefreshSelection(generation.selection),
    expected: readCodexConnectedServiceExpected(record.expected),
  };
}

export function resolveCodexAppliedProfileId(input: Readonly<{
  credential: ConnectedServiceCredentialRecordV1;
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

export async function writeCodexConnectedServiceAuthStore(input: Readonly<{
  codexHome: string;
  credential: Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>;
}>): Promise<void> {
  await writeAtomicJsonFile({
    path: join(input.codexHome, 'auth.json'),
    mode: 0o600,
    value: buildCodexCloudAuthFile({
      accessToken: input.credential.oauth.accessToken,
      refreshToken: input.credential.oauth.refreshToken,
      idToken: input.credential.oauth.idToken,
      accountId: input.credential.oauth.providerAccountId,
      lastRefreshIso: new Date().toISOString(),
    }),
  });
}
