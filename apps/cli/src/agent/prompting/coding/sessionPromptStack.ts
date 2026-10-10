import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { PromptStackScopeV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { migrateRetainedSessionWorkContextV1, readSessionMemoryEnabledV1, SessionDisabledInheritedEntryIdsV1Schema,
  SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { Metadata } from '@/api/types';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountPromptStackSources,
  isActiveAccountSettingsSnapshotLifetimeCurrent,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSessionProjectPromptStack } from './sessionProjectPromptStack';

/** The Session producer retains its original Account lifetime and supplies its legacy Settings basis. */
export type SessionPromptStackAccountContext = Readonly<{
  scopeKey: string | null;
  lifetimeToken: number;
  settings: Record<string, unknown> | null;
}>;

export type SessionPromptStackInput = Readonly<{
  credentials?: StoredCredentials;
  metadata: Metadata | Readonly<Record<string, unknown>> | null;
  sessionId?: string;
  machineId: string;
  directory?: string;
  serverId?: string;
  signal?: AbortSignal;
  /** Search admission refreshes attachment membership through the incumbent catalog loaders. */
  refreshCatalogs?: boolean;
  /** Preserve the caller's original Account admission across asynchronous preparation. */
  accountContext?: SessionPromptStackAccountContext;
}>;

export type PreparedSessionPromptStackInputs = Readonly<{
  credentials?: StoredCredentials;
  serverId: string;
  scope: PromptStackScopeV1 | null;
  settings: Record<string, unknown> | null;
  profileId: string | null;
  profileCatalog?: ProfileCatalogSnapshotV1;
  accountEntries?: readonly PromptStackEntryV1[];
  profileEntries?: readonly PromptStackEntryV1[];
  sessionEntries: readonly PromptStackEntryV1[];
  projectEntries: readonly PromptStackEntryV1[];
  memoryEnabled: boolean;
  createdAsBot: boolean;
  disabledInheritedEntryIds: readonly string[];
  accountSnapshot: ActiveAccountSettingsSnapshot | null;
  /** Recheck after document reads, including failed preparation, before publishing private facts. */
  assertCurrentAccount: () => void;
}>;

/** One input owner for coding preparation and fresh daemon document admission; selection stays in Protocol. */
export async function prepareSessionPromptStackInputs(input: SessionPromptStackInput): Promise<PreparedSessionPromptStackInputs> {
  input.signal?.throwIfAborted();
  const accountContext = input.accountContext ?? {
    scopeKey: input.credentials ? resolveAccountSettingsScopeKey(input.credentials) : null,
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    settings: null,
  };
  const unavailable = (reason?: string): never => {
    throw Object.assign(new Error('context_source_unavailable'), {
      code: 'context_source_unavailable', status: 'preparation_pending', ...(reason ? { reason } : {}),
    });
  };
  const readCurrentAccount = (): ActiveAccountSettingsSnapshot | null => {
    input.signal?.throwIfAborted();
    if (!accountContext.scopeKey) return null;
    const current = getActiveAccountSettingsSnapshot();
    if (!current || !isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken })
      || (input.credentials && resolveAccountSettingsScopeKey(input.credentials) !== accountContext.scopeKey)) {
      return unavailable();
    }
    return current;
  };
  const assertCurrentAccount = () => { readCurrentAccount(); };
  try {
    const serverId = input.serverId ?? input.credentials?.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
    const accountId = input.credentials ? readAccountIdFromToken(input.credentials.token) : null;
    const metadata = input.metadata;
    const profileId = typeof metadata?.profileId === 'string' ? metadata.profileId : null;
    const projectId: unknown = metadata ? Reflect.get(metadata, 'projectId') : undefined;
    const workspaceId: unknown = metadata ? Reflect.get(metadata, 'workspaceId') : undefined;
    const projectKey = typeof projectId === 'string' ? projectId.trim() : undefined;
    const scope: PromptStackScopeV1 | null = accountId ? {
      serverId, accountId, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(projectKey ? { projectKey } : {}), ...(profileId ? { profileId } : {}),
    } : null;
    let currentAccount = readCurrentAccount();
    if (accountContext.scopeKey && currentAccount && input.credentials) {
      const demand: Promise<unknown>[] = [];
      const { prepareActivePromptLibraryRecord, refreshActivePromptLibraryCatalog } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
      // Import completion cannot admit a replacement Account lifetime.
      assertCurrentAccount();
      demand.push(input.refreshCatalogs
        ? refreshActivePromptLibraryCatalog({ credentials: input.credentials, signal: input.signal })
        : prepareActivePromptLibraryRecord({ credentials: input.credentials, scopeKey: accountContext.scopeKey,
            lifetimeToken: accountContext.lifetimeToken, key: 'coding', signal: input.signal }));
      if (profileId && (input.refreshCatalogs || currentAccount.profileCatalog?.status !== 'ready')) {
        const { refreshActiveProfileCatalog } = await import('@/settings/profiles/hydrateProfileCatalog');
        assertCurrentAccount();
        demand.push(refreshActiveProfileCatalog({ credentials: input.credentials, signal: input.signal }));
      }
      await Promise.all(demand);
      currentAccount = readCurrentAccount();
    }
    const settings = currentAccount?.settings ?? accountContext.settings;
    const work = migrateRetainedSessionWorkContextV1(metadata?.work);
    const sessionEntries = createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? []);
    const disabledInheritedEntryIds = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema).parse(work.disabledInheritedEntryIds ?? []);
    const accountSources = accountContext.scopeKey ? readActiveAccountPromptStackSources({
      scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken, surface: 'coding', profileId,
    }) : null;
    if (accountSources?.status === 'unavailable') return unavailable(accountSources.reason);
    if (!input.credentials && (workspaceId !== undefined || projectId !== undefined)) return unavailable();
    const projectEntries = input.credentials ? await resolveSessionProjectPromptStack({
      credentials: input.credentials, metadata, signal: input.signal, machineId: input.machineId, directory: input.directory, serverId,
    }) : [];
    assertCurrentAccount();
    return {
      credentials: input.credentials, serverId, scope, settings, profileId,
      ...(currentAccount?.profileCatalog ? { profileCatalog: currentAccount.profileCatalog } : {}),
      ...(accountSources?.status === 'ready' ? { accountEntries: accountSources.accountEntries, profileEntries: accountSources.profileEntries } : {}),
      sessionEntries, projectEntries, memoryEnabled: readSessionMemoryEnabledV1(metadata),
      createdAsBot: metadata?.createdAsBot === true, disabledInheritedEntryIds, accountSnapshot: currentAccount, assertCurrentAccount,
    };
  } catch (error) {
    assertCurrentAccount();
    throw error;
  }
}
