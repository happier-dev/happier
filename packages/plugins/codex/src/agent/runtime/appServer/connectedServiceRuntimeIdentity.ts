import type { CodexConnectedServiceRefreshSelection } from '../../auth/services/runtime/auth/application.js';
import { readCodexEnvironmentAuthTokens } from '../../cli/auth/environment.js';

const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';

export type CodexConnectedServiceRuntimeIdentitySource =
  | 'spawn_selection'
  | 'applied_credential'
  | 'live_account_read';

export type CodexConnectedServiceRuntimeIdentity = Readonly<{
  serviceId: 'openai-codex';
  providerAccountId: string;
  profileId: string;
  groupId: string | null;
  generation: number | null;
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
): CodexConnectedServiceRuntimeIdentity | null {
  const selection = resolveCodexConnectedServiceRefreshSelectionFromEnv(env);
  if (!selection) return null;

  const authTokens = readCodexEnvironmentAuthTokens(env);
  if (!authTokens.accountId) return null;

  if (selection.kind === 'group') {
    return {
      serviceId: 'openai-codex',
      providerAccountId: authTokens.accountId,
      accountLabel: authTokens.accountLabel,
      profileId: selection.activeProfileId,
      groupId: selection.groupId,
      generation: selection.generation,
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
    source: 'spawn_selection',
  };
}

export function buildCodexLiveAccountRuntimeIdentity(input: Readonly<{
  liveProviderAccount: CodexLiveProviderAccountIdentity;
  currentSelection: CodexConnectedServiceRefreshSelection | null;
  previousIdentity: CodexConnectedServiceRuntimeIdentity | null;
}>): CodexConnectedServiceRuntimeIdentity | null {
  const providerAccountId = input.liveProviderAccount.providerAccountId?.trim();
  if (!providerAccountId) return null;

  const selection = input.currentSelection;
  if (selection?.kind === 'group') {
    return {
      serviceId: 'openai-codex',
      providerAccountId,
      accountLabel: input.liveProviderAccount.providerEmail,
      profileId: selection.activeProfileId,
      groupId: selection.groupId,
      generation: selection.generation,
      source: 'live_account_read',
    };
  }

  if (selection?.kind === 'profile') {
    return {
      serviceId: 'openai-codex',
      providerAccountId,
      accountLabel: input.liveProviderAccount.providerEmail,
      profileId: selection.profileId,
      groupId: null,
      generation: null,
      source: 'live_account_read',
    };
  }

  const previous = input.previousIdentity;
  if (!previous) return null;
  return {
    ...previous,
    providerAccountId,
    accountLabel: input.liveProviderAccount.providerEmail ?? previous.accountLabel,
    source: 'live_account_read',
  };
}
