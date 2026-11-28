import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { assertPromptStackArtifactHeaderV1, PromptStackPreparationError, type PromptStackScopeV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { migrateRetainedSessionWorkContextV1, readSessionMemoryEnabledV1, SessionDisabledInheritedEntryIdsV1Schema,
  SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { Metadata } from '@/api/types';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountPromptStackSources,
  readAccountPromptStackSources,
  isActiveAccountSettingsSnapshotLifetimeCurrent,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSessionProjectPromptStack, type SessionProjectPromptStackPreparation } from './sessionProjectPromptStack';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { logger } from '@/ui/logger';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

/** Birth copies Session memory attachments, not document bodies or the lead's instructions/identity.
 * Account/Profile/Project context continues to resolve through the worker's own composition. */
export async function prepareSessionMemoryInheritance(input: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials;
  serverId?: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ memoryEnabled: boolean; promptStack: PromptStackEntryV1[] }>> {
  input.signal?.throwIfAborted();
  const memoryEnabled = readSessionMemoryEnabledV1(input.metadata);
  const work = migrateRetainedSessionWorkContextV1(input.metadata?.work);
  const entries = createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? [])
    .filter(entry => entry.ref.kind === 'doc' && entry.id !== 'session.instructions');
  if (entries.length === 0) return { memoryEnabled, promptStack: [] };
  // Birth inheritance must read with its Session owner's material, never the
  // ambient Account selected by the generic prompt-library reader.
  if (!input.credentials) throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable' });
  return withCliPromptLibraryArtifactReader(async reader => {
    const scope = await reader.readScope();
    if (!scope) throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable' });
    const promptStack: PromptStackEntryV1[] = [];
    for (const entry of entries) {
      const ref = { ...entry.ref, serverId: entry.ref.serverId ?? scope.serverId };
      // Birth inheritance is same-Home/Account only. Never select saved credentials for another Home.
      if (!await isServerProfileHomeIdentity(scope.serverId, ref.serverId)) throw new PromptStackPreparationError('unavailable', ref);
      const artifact = await reader.readArtifactHeader(ref);
      if (!artifact) throw new PromptStackPreparationError('unavailable', ref);
      assertPromptStackArtifactHeaderV1(ref, artifact.header, { layer: 'session', entryId: entry.id, memoryEnabled });
      if (artifact.header?.kind === 'memory_doc.v1') promptStack.push({ ...entry, ref });
    }
    input.signal?.throwIfAborted();
    return { memoryEnabled, promptStack };
  }, input);
}

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
  /** Finite admission may share one fresh Project inventory across its Sessions. */
  projectPreparation?: SessionProjectPromptStackPreparation;
  /** Already-admitted context; explicit [] withholds private Project inference. */
  projectEntries?: readonly PromptStackEntryV1[];
  operationContext?: SavedSecretOperationContextV1;
}>;

export type PreparedSessionPromptStackInputs = Readonly<{
  credentials?: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
  serverId: string;
  scope: PromptStackScopeV1 | null;
  settings: Record<string, unknown> | null;
  profileId: string | null;
  profileCatalog?: ProfileCatalogSnapshotV1;
  accountEntries?: readonly PromptStackEntryV1[];
  profileEntries?: readonly PromptStackEntryV1[];
  sessionEntries: readonly PromptStackEntryV1[];
  projectEntries: readonly PromptStackEntryV1[];
  workspaceRef?: WorkspaceRefV1 | null;
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
  const unavailable = (reason?: string, contextSource: 'account_lifetime' | 'account_prompt_inventory' | 'profile_prompt_inventory' | 'project_association' = 'account_lifetime'): never => {
    const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    logger.infoFile('[prompts] Context source unavailable', {
      sessionId: input.sessionId, contextSource, reason: reason ?? 'scope-unavailable',
      accountSnapshotSource: snapshot?.source ?? 'absent',
      promptLibraryStatus: snapshot?.promptLibraryCatalog?.status ?? 'unobserved',
      profileCatalogStatus: snapshot?.profileCatalog?.status ?? 'unobserved',
    });
    throw Object.assign(new Error('context_source_unavailable'), {
      code: 'context_source_unavailable', status: 'preparation_pending', contextSource, ...(reason ? { reason } : {}),
    });
  };
  const readCurrentAccount = (): ActiveAccountSettingsSnapshot | null => {
    input.signal?.throwIfAborted();
    if (!accountContext.scopeKey) return null;
    const current = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!current || current.scopeKey !== accountContext.scopeKey
      || !isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken })
      || (input.credentials && resolveAccountSettingsScopeKey(input.credentials) !== accountContext.scopeKey)) {
      return unavailable();
    }
    return current;
  };
  const assertCurrentAccount = () => { readCurrentAccount(); };
  const assertOperationCurrent = async () => {
    assertCurrentAccount();
    if (input.operationContext && (!input.credentials
      || !sameStoredCredentials(input.operationContext.credentials, input.credentials)
      || !await input.operationContext.isCurrent())) return unavailable('scope-retired');
    assertCurrentAccount();
  };
  try {
    await assertOperationCurrent();
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
      logger.infoFile('[prompts] Account prompt source demand', {
        sessionId: input.sessionId, capturedAccount: input.operationContext !== undefined,
        accountSnapshotSource: currentAccount.source,
        promptLibraryStatus: currentAccount.promptLibraryCatalog?.status ?? 'unobserved',
        profileCatalogStatus: currentAccount.profileCatalog?.status ?? 'unobserved',
      });
      const { prepareActivePromptLibraryRecord } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
      // Import completion cannot admit a replacement Account lifetime.
      assertCurrentAccount();
      if (profileId && (input.refreshCatalogs || currentAccount.profileCatalog?.status !== 'ready')) {
        const { refreshActiveProfileCatalog } = await import('@/settings/profiles/hydrateProfileCatalog');
        assertCurrentAccount();
        await refreshActiveProfileCatalog({ credentials: input.credentials, signal: input.signal, operationContext: input.operationContext });
      }
      // Profile preparation can observe an Account wake that withdraws the
      // earlier prompt inventory. Demand its readiness at the consumption cut.
      await prepareActivePromptLibraryRecord({ credentials: input.credentials, scopeKey: accountContext.scopeKey,
        lifetimeToken: accountContext.lifetimeToken, key: 'coding', signal: input.signal, operationContext: input.operationContext,
        ...(input.refreshCatalogs && !input.operationContext ? { refresh: true } : {}) });
      await assertOperationCurrent();
      currentAccount = readCurrentAccount();
    }
    const settings = currentAccount?.settings ?? accountContext.settings;
    const work = migrateRetainedSessionWorkContextV1(metadata?.work);
    const sessionEntries = createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? []);
    const disabledInheritedEntryIds = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema).parse(work.disabledInheritedEntryIds ?? []);
    const sourceSelection = { surface: 'coding' as const, profileId };
    const accountSources = accountContext.scopeKey ? input.operationContext && currentAccount
      ? readAccountPromptStackSources(currentAccount, sourceSelection) : readActiveAccountPromptStackSources({
      scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken, surface: 'coding', profileId,
    }) : null;
    logger.infoFile('[prompts] Account prompt source readiness', {
      sessionId: input.sessionId, capturedAccount: input.operationContext !== undefined,
      accountSnapshotSource: currentAccount?.source ?? 'absent',
      promptLibraryStatus: currentAccount?.promptLibraryCatalog?.status ?? 'unobserved',
      profileCatalogStatus: currentAccount?.profileCatalog?.status ?? 'unobserved',
      selectionStatus: accountSources?.status ?? 'not_applicable',
      ...(accountSources?.status === 'unavailable' ? { reason: accountSources.reason } : {}),
    });
    if (accountSources?.status === 'unavailable') {
      const accountInventory = currentAccount ? readAccountPromptStackSources(currentAccount, { surface: 'coding' }) : null;
      return unavailable(accountSources.reason, accountInventory?.status === 'ready' ? 'profile_prompt_inventory' : 'account_prompt_inventory');
    }
    if (!input.credentials && (workspaceId !== undefined || projectId !== undefined)) return unavailable(undefined, 'project_association');
    const projectInput = {
      metadata, signal: input.signal, machineId: input.machineId, directory: input.directory, serverId,
      operationContext: input.operationContext,
    };
    const projectResolution = input.projectEntries === undefined && input.credentials
      ? await (input.projectPreparation
        ? input.projectPreparation.resolve({ metadata, machineId: input.machineId, directory: input.directory })
        : resolveSessionProjectPromptStack({
          credentials: input.credentials, ...projectInput,
        }))
      : null;
    const projectEntries: readonly PromptStackEntryV1[] = input.projectEntries ?? projectResolution?.entries ?? [];
    const workspaceRef = projectResolution?.workspaceRef ?? null;
    await assertOperationCurrent();
    return {
      credentials: input.credentials, operationContext: input.operationContext, serverId, scope, settings, profileId,
      ...(currentAccount?.profileCatalog ? { profileCatalog: currentAccount.profileCatalog } : {}),
      ...(accountSources?.status === 'ready' ? { accountEntries: accountSources.accountEntries, profileEntries: accountSources.profileEntries } : {}),
      sessionEntries, projectEntries, ...(workspaceRef ? { workspaceRef } : {}), memoryEnabled: readSessionMemoryEnabledV1(metadata),
      createdAsBot: metadata?.createdAsBot === true, disabledInheritedEntryIds, accountSnapshot: currentAccount, assertCurrentAccount,
    };
  } catch (error) {
    await assertOperationCurrent();
    throw error;
  }
}
