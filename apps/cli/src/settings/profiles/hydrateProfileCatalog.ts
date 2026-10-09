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
import { beginActiveProfileCatalogRefresh, commitActiveAccountSettingsSnapshot, commitActiveProfileCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
export { readActiveProfileCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, Promise<ProfileCatalogSnapshotV1>>();
const reloadAfterPending = new Set<string>();
/** Demand-load one existing Account lifetime; newer preference revisions do not retire it. */
export function refreshActiveProfileCatalog(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1 }>): Promise<ProfileCatalogSnapshotV1> {
  return input.operationContext ? runWithServerHttpBaseUrl(input.operationContext.serverHttpBaseUrl,
    () => refreshCapturedProfileCatalog(input)) : refreshCapturedProfileCatalog(input);
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
  work = (async () => {
    while (true) {
      if (!context) reloadAfterPending.delete(key);
      let catalog: ProfileCatalogSnapshotV1;
      try {
        if (context && !await context.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
        catalog = await store.readProfileCatalog();
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
            if (result.status === 'active' || result.status === 'not-required') catalog = await store.readProfileCatalog();
          } finally {
            await lease?.release();
          }
        }
        if (!context && reloadAfterPending.has(key)) continue;
        if (catalog.status === 'ready' && catalog.control?.record.phase === 'active') {
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
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable' };
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
