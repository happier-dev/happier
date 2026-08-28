import type { CodexConnectedServiceRefreshSelection } from '../../auth/services/runtime/auth/application.js';
import type { CodexEnvironmentAuthTokens } from '../../cli/auth/environment.js';
import { createHash } from 'node:crypto';

const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';

export type CodexConnectedServiceRuntimeIdentitySource =
  | 'spawn_selection'
  | 'applied_credential'
  | 'live_account_read'
  | 'token_refresh';

export type CodexConnectedServiceRuntimeIdentity = Readonly<{
  serviceId: 'openai-codex';
  providerAccountId: string;
  profileId: string;
  groupId: string | null;
  generation: number | null;
  credentialFingerprint: string | null;
  credentialRevision: string | null;
  accountLabel: string | null;
  source: CodexConnectedServiceRuntimeIdentitySource;
}>;

export type CodexLiveProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerEmail: string | null;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function trimString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function readGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function readCodexConnectedServiceSelection(value: unknown): CodexConnectedServiceRefreshSelection | null {
  const record = readRecord(value);
  if (!record || record.serviceId !== 'openai-codex') return null;

  if (record.kind === 'profile') {
    const profileId = trimString(record.profileId);
    return profileId
      ? { kind: 'profile', serviceId: 'openai-codex', profileId }
      : null;
  }

  if (record.kind !== 'group') return null;
  const groupId = trimString(record.groupId);
  const activeProfileId = trimString(record.activeProfileId);
  const generation = readGeneration(record.generation);
  if (!groupId || !activeProfileId || generation === null) return null;
  const fallbackProfileId = trimString(record.fallbackProfileId);
  return {
    kind: 'group',
    serviceId: 'openai-codex',
    groupId,
    activeProfileId,
    ...(fallbackProfileId ? { fallbackProfileId } : {}),
    generation,
  };
}

function resolveCodexConnectedServiceCredentialRevisionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const raw = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    const record = readRecord(item);
    if (record?.serviceId !== 'openai-codex') continue;
    return trimString(record.credentialRevision);
  }
  return null;
}

export function computeCodexAccessTokenFingerprint(accessToken: string | null | undefined): string | null {
  const normalized = accessToken?.trim();
  if (!normalized) return null;
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`;
}

export function resolveCodexConnectedServiceRefreshSelectionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CodexConnectedServiceRefreshSelection | null {
  const raw = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    const selection = readCodexConnectedServiceSelection(item);
    if (selection) return selection;
  }
  return null;
}

export function resolveCodexInitialConnectedServiceRuntimeIdentity(
  env: Readonly<Record<string, string | undefined>>,
  authTokens: CodexEnvironmentAuthTokens | null,
): CodexConnectedServiceRuntimeIdentity | null {
  const selection = resolveCodexConnectedServiceRefreshSelectionFromEnv(env);
  if (!selection) return null;

  if (!authTokens?.accountId) return null;
  const credentialFingerprint = computeCodexAccessTokenFingerprint(authTokens.accessToken ?? authTokens.idToken);
  const credentialRevision = resolveCodexConnectedServiceCredentialRevisionFromEnv(env);

  if (selection.kind === 'group') {
    return {
      serviceId: 'openai-codex',
      providerAccountId: authTokens.accountId,
      accountLabel: authTokens.accountLabel,
      profileId: selection.activeProfileId,
      groupId: selection.groupId,
      generation: selection.generation,
      credentialFingerprint,
      credentialRevision,
      source: 'spawn_selection',
    };
  }

  return {
    serviceId: 'openai-codex',
    providerAccountId: authTokens.accountId,
    accountLabel: authTokens.accountLabel,
    profileId: selection.profileId,
    groupId: null,
    generation: null,
    credentialFingerprint,
    credentialRevision,
    source: 'spawn_selection',
  };
}

export function buildCodexLiveAccountRuntimeIdentity(input: Readonly<{
  liveProviderAccount: CodexLiveProviderAccountIdentity;
  currentSelection: CodexConnectedServiceRefreshSelection | null;
  previousIdentity: CodexConnectedServiceRuntimeIdentity | null;
}>): CodexConnectedServiceRuntimeIdentity | null {
  const providerAccountId = input.liveProviderAccount.providerAccountId?.trim();
  const previous = input.previousIdentity;
  if (!providerAccountId || !previous || providerAccountId !== previous.providerAccountId) return null;
  const selection = input.currentSelection;
  const selectionMatches = selection?.kind === 'group'
    ? previous.profileId === selection.activeProfileId
      && previous.groupId === selection.groupId
      && previous.generation === selection.generation
    : selection?.kind === 'profile'
      ? previous.profileId === selection.profileId && previous.groupId === null
      : true;
  if (!selectionMatches) return null;
  return {
    ...previous,
    accountLabel: input.liveProviderAccount.providerEmail ?? previous.accountLabel,
    source: 'live_account_read',
  };
}
