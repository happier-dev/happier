import type { ConnectedMetadataCatalogV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  beginActiveConnectedPresentationCatalogRefresh, beginActiveConnectedAcknowledgementsCatalogRefresh,
  commitActiveConnectedPresentationCatalog, commitActiveConnectedAcknowledgementsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; serverHttpBaseUrl?: string;
  authorizeRequest?: Parameters<(typeof import('./connectedMetadataStore'))['createCliConnectedMetadataStore']>[0]['authorizeRequest'];
  isCredentialCurrent?: () => boolean | Promise<boolean> }>;
type CapturedAccount = Readonly<{ scopeKey: string; lifetimeToken: number }>;
const pending = new Map<string, Promise<ConnectedMetadataCatalogV1>>();
const refreshAfterInFlight = new Set<string>();

function unavailable(reason: string): ConnectedMetadataCatalogV1 {
  return { presentation: { status: 'unavailable', reason }, acknowledgements: { status: 'unavailable', reason }, disclosure: [] };
}

/** One captured demand using the incumbent Account lifetime and publication owner. */
function refresh(input: RefreshInput, captured?: CapturedAccount, afterChange = false): Promise<ConnectedMetadataCatalogV1> {
  const scopeKey = captured?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = captured?.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const capture = { scopeKey, lifetimeToken };
  const key = `${scopeKey}:${lifetimeToken}`;
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  const begin = () => {
    beginActiveConnectedPresentationCatalogRefresh(capture);
    beginActiveConnectedAcknowledgementsCatalogRefresh(capture);
  };
  const commit = (catalog: ConnectedMetadataCatalogV1) => {
    commitActiveConnectedPresentationCatalog({ ...capture, catalog: catalog.presentation });
    commitActiveConnectedAcknowledgementsCatalog({ ...capture, catalog: catalog.acknowledgements });
  };
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey || (!afterChange && input.signal?.aborted)) {
    return Promise.resolve(unavailable('scope-retired'));
  }
  const existing = pending.get(key);
  if (existing) {
    if (afterChange) { begin(); refreshAfterInFlight.add(key); }
    return existing;
  }
  begin();
  let work!: Promise<ConnectedMetadataCatalogV1>;
  work = (async () => {
    const uncancelledInput = { credentials: input.credentials, ...(input.serverHttpBaseUrl ? { serverHttpBaseUrl: input.serverHttpBaseUrl } : {}),
      ...(input.authorizeRequest ? { authorizeRequest: input.authorizeRequest } : {}),
      ...(input.isCredentialCurrent ? { isCredentialCurrent: input.isCredentialCurrent } : {}) };
    let requestInput: RefreshInput = afterChange ? uncancelledInput : input;
    while (true) {
      if (!current()) return unavailable('scope-retired');
      let catalog: ConnectedMetadataCatalogV1;
      try {
        const { createCliConnectedMetadataStore } = await import('./connectedMetadataStore');
        catalog = await createCliConnectedMetadataStore(requestInput).readCatalog(ready => {
          if (current() && !refreshAfterInFlight.has(key)) commit(ready);
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = unavailable(requestInput.signal?.aborted ? 'cancelled' : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
            : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
              : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable');
      }
      if (!current()) return unavailable('scope-retired');
      if (refreshAfterInFlight.delete(key)) { requestInput = uncancelledInput; continue; }
      if (pending.get(key) === work) pending.delete(key);
      commit(catalog);
      return catalog;
    }
  })().finally(() => {
    if (pending.get(key) === work) { pending.delete(key); refreshAfterInFlight.delete(key); }
    else if (!pending.has(key)) refreshAfterInFlight.delete(key);
  });
  pending.set(key, work);
  return work;
}

export function refreshActiveConnectedMetadataCatalog(input: RefreshInput): Promise<ConnectedMetadataCatalogV1> {
  return refresh(input);
}

/** A durable write or Account wake requires a read issued after that observation. */
export function refreshActiveConnectedMetadataCatalogAfterChange(input: RefreshInput & CapturedAccount): Promise<ConnectedMetadataCatalogV1> {
  return refresh(input, input, true);
}

/** No bootstrap/socket demand: refresh only facts already requested by a real consumer. */
export async function refreshDemandedActiveConnectedMetadataCatalog(input: Readonly<{ token: string; signal?: AbortSignal; serverHttpBaseUrl?: string }>): Promise<void> {
  const active = getActiveAccountSettingsSnapshot();
  if (!active?.scopeKey || active.connectedPresentationCatalog === undefined && active.connectedAcknowledgementsCatalog === undefined) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  input.signal?.throwIfAborted();
  await refreshActiveConnectedMetadataCatalogAfterChange({ credentials, scopeKey: active.scopeKey, lifetimeToken,
    ...(input.serverHttpBaseUrl ? { serverHttpBaseUrl: input.serverHttpBaseUrl } : {}) });
}
