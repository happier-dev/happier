import { $ZodError } from 'zod/v4/core';
import { waitForAccountEncryptionObservation } from '@happier-dev/sync-client';
import { artifactKindsMayIncludeKindV1, readArtifactKindsChangeHintV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import type { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { logger } from '@/ui/logger';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { StoredCredentials } from '@/persistence';
import { readStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { createCliProfileStore, createCliProfileStoreForOperation } from './profileStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { cleanupTransferredProfileSourcesV1, transferLegacyProfilesV1 } from '@happier-dev/protocol/profiles/transferLegacyProfilesV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { isDeepStrictEqual } from 'node:util';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import { loadAiLaunchProfileArtifacts } from '@happier-dev/protocol/profiles/read';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1, loadReadableApprovalProfilesV1, listReadableApprovalProfilesV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import type { ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { commitActiveApprovalProfileCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { beginActiveProfileCatalogRefresh, commitActiveAccountSettingsSnapshot, commitActiveProfileCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
export { readActiveProfileCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, Promise<ProfileCatalogSnapshotV1>>();
const reloadAfterPending = new Set<string>();
/** Demand-load one existing Account lifetime; newer preference revisions do not retire it. */
export function refreshActiveProfileCatalog(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1 }>): Promise<ProfileCatalogSnapshotV1> {
  return refreshProfileCatalogInHome(input, false);
}

/** Current launch reads reobserve active rows without resuming optional source/history cleanup. */
export function reobserveActiveProfileCatalog(input: Parameters<typeof refreshActiveProfileCatalog>[0]): Promise<ProfileCatalogSnapshotV1> {
  const catalog = (input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.profileCatalog;
  return refreshProfileCatalogInHome(input, catalog?.status === 'ready' && catalog.source === 'destination' && catalog.authority === 'active');
}

function refreshProfileCatalogInHome(input: Parameters<typeof refreshActiveProfileCatalog>[0], reobserve: boolean): Promise<ProfileCatalogSnapshotV1> {
  return input.operationContext ? runWithServerHttpBaseUrl(input.operationContext.serverHttpBaseUrl,
    () => refreshCapturedProfileCatalog(input, reobserve)) : refreshCapturedProfileCatalog(input, reobserve);
}

function refreshCapturedProfileCatalog(input: Parameters<typeof refreshActiveProfileCatalog>[0], reobserve = false): Promise<ProfileCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  let expectedSettingsVersion = readSnapshot()?.settingsVersion;
  const current = () => !input.signal?.aborted && readSnapshot()?.scopeKey === scopeKey
    && (context ? context.credentials.token === input.credentials.token : getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  if (!current()) return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  const existing = context ? undefined : pending.get(key);
  if (existing) {
    if (reobserve) {
      reloadAfterPending.add(key);
      beginActiveProfileCatalogRefresh({ scopeKey, lifetimeToken });
    }
    return existing;
  }
  if (!context) beginActiveProfileCatalogRefresh({ scopeKey, lifetimeToken });
  const store = context ? createCliProfileStoreForOperation({ operationContext: context, signal: input.signal }) : createCliProfileStore(input);
  const serverUrl = resolveServerHttpBaseUrl();
  const homeServerId = input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  const publishCatalog = async (catalog: ProfileCatalogSnapshotV1) => {
    if (!current() || context && !await context.isCurrent()) return false;
    return context ? expectedSettingsVersion !== undefined
      && await context.commitProfileCatalog({ expectedSettingsVersion, catalog })
      : commitActiveProfileCatalog({ scopeKey, lifetimeToken, catalog });
  };
  let work!: Promise<ProfileCatalogSnapshotV1>;
  let maintainSource = !reobserve;
  work = (async (): Promise<ProfileCatalogSnapshotV1> => {
    while (true) {
      if (!context && reloadAfterPending.delete(key)) maintainSource = false;
      let catalog: ProfileCatalogSnapshotV1;
      try {
        if (context && !await context.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
        catalog = await store.readProfileCatalog({ migrateSkills: true });
        if (catalog.status === 'ready' && catalog.source === 'legacy') {
          const source = await store.readSourceSnapshot();
          const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
          const artifacts = createCredentialedAccountArtifactStore(input.credentials);
          const artifactsById = await runWithServerHttpBaseUrl(serverUrl, () => loadAiLaunchProfileArtifacts(source.raw.profiles, artifacts, input.signal));
          const { tryAcquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
          const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
          try {
            const result = await transferLegacyProfilesV1({ source, catalog, artifactsById, homeServerId,
              providerContributions: lease?.registry.contributes.providersByContributionKey
                ? [...lease.registry.contributes.providersByContributionKey.values()].map((entry) => entry.definition) : null,
              mode: source.mode, material: source.material, assertCurrent: store.assertCurrent, signal: input.signal,
              mutateTransfer: store.mutateTransfer, reloadCatalog: store.readProfileCatalog,
              readSavedSecretRevisions: async (refs) => {
                const { refreshSavedSecretCatalogForOperation } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
                const { readSavedSecretRevisionsFromSnapshotV1 } = await import('@/settings/secrets/savedSecretCatalog');
                try {
                  await refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, references: refs.map((ref) => ({ ref })), signal: input.signal,
                    ...(context ? { operationContext: context } : {}) });
                  store.assertCurrent();
                  return readSavedSecretRevisionsFromSnapshotV1(readSnapshot(), refs);
                } catch {
                  store.assertCurrent();
                  return { status: 'unavailable' as const };
                }
              },
              readArtifactRevisions: async (ids) => {
                const resourcesByRef = new Map<string, Readonly<{ headerVersion: number; bodyVersion: number }>>();
                for (const id of ids) {
                  const artifact = await runWithServerHttpBaseUrl(serverUrl, () => artifacts.read(id, { signal: input.signal }));
                  store.assertCurrent();
                  if (!artifact) return { status: 'partial' as const };
                  resourcesByRef.set(id, artifact.revision);
                }
                return { status: 'ready' as const, resourcesByRef };
              },
            });
            if (result.status === 'active' || result.status === 'not-required') catalog = await store.readProfileCatalog({ migrateSkills: true });
          } finally {
            await lease?.release();
          }
        }
        if (!context && reloadAfterPending.has(key)) continue;
        if (maintainSource && catalog.status === 'ready' && catalog.control?.record.phase === 'active') {
          // Cleanup does not own destination admission. Publish the complete current
          // catalog first, then let the existing transfer owner resume source/history work.
          if (!await publishCatalog(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
          await cleanupTransferredProfileSourcesV1({ control: catalog.control, assertCurrent: store.assertCurrent,
            signal: input.signal, reloadCatalog: store.readProfileCatalog, readSource: store.readSourceSnapshot,
            replaceSource: async value => {
              const result = await store.replaceSource(value);
              if (result.status !== 'applied') return result;
              const observed = await store.readSourceSnapshot();
              const previous = readSnapshot();
              if (!previous || !current() || observed.version !== result.settingsVersion
                || !isDeepStrictEqual(observed.raw, value.raw)) return { status: 'rejected' };
              const next = { ...previous, source: 'network' as const, settings: accountSettingsParse(observed.raw),
                rawSettings: observed.raw, settingsVersion: observed.version };
              if (context) {
                if (!await context.replaceAccountSettings(next)) return { status: 'rejected' };
              } else commitActiveAccountSettingsSnapshot(next);
              expectedSettingsVersion = readSnapshot()?.settingsVersion;
              return result;
            },
            normalizeHistory: value => normalizeCliAccountSettingsHistoryAfterTransfer({ credentials: input.credentials,
              serverBaseUrl: serverUrl, signal: input.signal, isCurrent: async () => current() && (!context || await context.isCurrent()),
              expectedProfileTransferRevision: value.expectedProfileTransferRevision,
              destinationAuthority: { activeTransferredRoots: value.activeTransferredRoots } }),
          });
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' ? code
          : isRetryableAccountEncryptionCurrentnessError(error) ? 'unreachable'
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!context && reloadAfterPending.has(key)) continue;
      if (!await publishCatalog(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      if (context || !reloadAfterPending.has(key)) return catalog;
    }
  })().finally(() => {
    if (pending.get(key) === work) {
      pending.delete(key);
      reloadAfterPending.delete(key);
    }
  });
  if (!context) pending.set(key, work);
  return work;
}

/** Existing Account observer refreshes only an already-demanded domain. */
export async function refreshDemandedActiveProfileCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  if (getActiveAccountSettingsSnapshot()?.profileCatalog === undefined) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await refreshCapturedProfileCatalog({ credentials, signal: input.signal }, true);
}

export type ApprovalProfileCatalogInvalidation = Readonly<{ artifactIds?: readonly string[] }>;

/** Shared Artifact kind routing for active and requester-owned approval catalogs. */
export function readApprovalProfileCatalogInvalidation(changes: readonly ChangeEntry[]): ApprovalProfileCatalogInvalidation | null {
  const changed = changes.filter(change => change.kind === 'artifact'
    && artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint), [APPROVAL_PROFILE_ARTIFACT_KIND_V1]));
  if (!changed.length) return null;
  return changed.every(change => !artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint), []))
    ? { artifactIds: [...new Set(changed.map(change => change.entityId))] } : {};
}

const pendingApprovalProfiles = new Map<string | SavedSecretOperationContextV1, Promise<readonly ReadableApprovalProfileV1[]>>();
const reobserveApprovalProfilesAfterPending = new Set<string | SavedSecretOperationContextV1>();

/** The retained requester consumes the same Account feed into its own opened catalog. */
export function createRequesterApprovalProfilePublication(input: Readonly<{
  observation: Pick<ReturnType<typeof acquireRequesterAccountEncryptionCurrentness>, 'subscribeApprovalProfiles'>;
  operationContext: SavedSecretOperationContextV1;
  signal: AbortSignal;
}>) {
  const context = input.operationContext;
  const isDemanded = () => context.readSnapshot()?.approvalProfileCatalog !== undefined || pendingApprovalProfiles.has(context);
  const release = input.observation.subscribeApprovalProfiles(change => {
    void refreshActiveApprovalProfileCatalog({ credentials: context.credentials, operationContext: context,
      signal: input.signal, reobserve: true, ...change }).catch(() => {
      if (!input.signal.aborted) logger.warn('Requester approval profile publication unavailable.');
    });
  }, isDemanded);
  return Object.freeze({
    async ensureCurrent(signal?: AbortSignal) {
      const readerSignal = signal ? AbortSignal.any([signal, input.signal]) : input.signal;
      let observed: ReturnType<typeof pendingApprovalProfiles.get>;
      do {
        observed = pendingApprovalProfiles.get(context);
        if (observed) await waitForAccountEncryptionObservation(observed, readerSignal);
      } while (pendingApprovalProfiles.has(context) && observed !== pendingApprovalProfiles.get(context));
      return !readerSignal.aborted && context.readSnapshot() !== null;
    },
    dispose: release,
  });
}

/** Opened approval profiles share the existing Account lifetime and Artifact transport. */
export function refreshActiveApprovalProfileCatalog(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  artifactIds?: readonly string[]; reobserve?: boolean;
}>): Promise<readonly ReadableApprovalProfileV1[]> {
  const activate = async () => {
    const context = input.operationContext;
    const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
    if (!context && getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey) {
      const { bootstrapAccountSettingsContext } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
      await bootstrapAccountSettingsContext({ credentials: input.credentials, mode: 'blocking', signal: input.signal });
    }
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const read = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
    const current = () => !input.signal?.aborted && read()?.source !== 'none' && read()?.scopeKey === scopeKey
      && (context !== undefined || getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
    if (!current()) return [];
    const key = context ?? `${scopeKey}:${lifetimeToken}`;
    const existing = pendingApprovalProfiles.get(key);
    if (existing) {
      if (input.reobserve || input.artifactIds) reobserveApprovalProfilesAfterPending.add(key);
      return existing;
    }
    const work = (async () => {
      const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
      const store = createCredentialedAccountArtifactStore(input.credentials);
      let artifactIds = input.artifactIds;
      while (true) {
        reobserveApprovalProfilesAfterPending.delete(key);
        let catalog: readonly ReadableApprovalProfileV1[];
        const prior = read()?.approvalProfileCatalog;
        try {
          if (artifactIds && prior) {
            const ids = new Set(artifactIds);
            const changed = await Promise.all([...ids].map(id => store.read(id, { signal: input.signal })));
            catalog = [...prior.filter(row => !ids.has(row.id)), ...listReadableApprovalProfilesV1(changed.flatMap(row => row ? [row] : []))];
          } else catalog = await loadReadableApprovalProfilesV1(store.list, input.signal);
        } catch (error) {
          input.signal?.throwIfAborted();
          // Only a successful read can withdraw a profile. A failed re-read keeps the held
          // catalog; a failed first read leaves none, so admission refuses rather than
          // deciding on Account settings without the Session's profile.
          if (prior) return prior;
          throw error;
        }
        if (!current()) return [];
        if (reobserveApprovalProfilesAfterPending.has(key)) {
          artifactIds = undefined;
          continue;
        }
        const committed = context ? await context.commitApprovalProfileCatalog(catalog)
          : commitActiveApprovalProfileCatalog({ scopeKey, lifetimeToken, catalog });
        // Private publication may await Home; retain any wake received during that commit.
        if (reobserveApprovalProfilesAfterPending.has(key)) {
          artifactIds = undefined;
          continue;
        }
        return committed ? read()?.approvalProfileCatalog ?? [] : [];
      }
    })();
    pendingApprovalProfiles.set(key, work);
    try { return await work; }
    finally { if (pendingApprovalProfiles.get(key) === work) {
      pendingApprovalProfiles.delete(key);
      reobserveApprovalProfilesAfterPending.delete(key);
    } }
  };
  return input.operationContext ? runWithServerHttpBaseUrl(input.operationContext.serverHttpBaseUrl, activate) : activate();
}

export async function refreshDemandedActiveApprovalProfileCatalog(input: Readonly<{
  token: string; signal?: AbortSignal; artifactIds?: readonly string[];
}>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  if (snapshot?.approvalProfileCatalog === undefined && !pendingApprovalProfiles.has(
    `${snapshot?.scopeKey}:${getActiveAccountSettingsSnapshotLifetimeToken()}`)) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await refreshActiveApprovalProfileCatalog({ credentials, signal: input.signal, artifactIds: input.artifactIds, reobserve: true });
}

/** A mutation receipt updates an already complete catalog without rereading its write. */
export async function publishApprovalProfileArtifactChange(input: Readonly<{
  credentials: StoredCredentials; operationContext?: SavedSecretOperationContextV1;
  id: string; profile?: ReadableApprovalProfileV1;
}>): Promise<void> {
  const context = input.operationContext;
  const snapshot = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  if (!snapshot?.approvalProfileCatalog || snapshot.scopeKey !== scopeKey || snapshot.source === 'none') return;
  const catalog = [...snapshot.approvalProfileCatalog.filter(row => row.id !== input.id), ...(input.profile ? [input.profile] : [])];
  if (context) await context.commitApprovalProfileCatalog(catalog);
  else commitActiveApprovalProfileCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog });
}
