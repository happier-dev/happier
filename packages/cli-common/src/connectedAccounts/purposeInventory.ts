import { isQualifiedConnectedAccountProfileActiveV4, isQualifiedConnectedAccountProfileUsableV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { PluginConnectedAccountAuthenticationV2, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef,
  QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol';
import { PluginError } from '../plugins/errors.js';

/** Existing Action-form inventory boundary, shared with the daemon projection. */
export const CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND = 256;
const CONNECTED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 512;

export type ConnectedAccountPurposeTargetSource = Readonly<{
  available: boolean;
  resolveService(service: QualifiedConnectedAccountRef['service'], signal: AbortSignal): Promise<Readonly<{
    service: QualifiedConnectedAccountRef['service']; authentication: PluginConnectedAccountAuthenticationV2;
  }> | null>;
  listAccounts(service: QualifiedConnectedAccountRef['service'], signal: AbortSignal, observationOnly?: boolean): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
  readGroup?: (ref: Readonly<{ service: QualifiedConnectedAccountRef['service']; groupId: string }>, signal: AbortSignal) => Promise<QualifiedConnectedAccountGroupV4 | null>;
}>;

export type ConnectedAccountPurposeInventoryEntry = Readonly<{
  account: QualifiedConnectedAccountRef;
  displayName: string;
  state: 'connected' | 'reconnectRequired' | 'expired' | 'unavailable';
}>;

export function readConnectedAccountPurposeProfileLabel(profile: Pick<QualifiedConnectedAccountProfileV4, 'displayName' | 'providerIdentity'>): string | null {
  return profile.displayName ?? profile.providerIdentity?.email ?? profile.providerIdentity?.accountId ?? null;
}

function inventoryKey(account: QualifiedConnectedAccountRef): string {
  return JSON.stringify([account.service.pluginId, account.service.localId, account.accountId]);
}

function boundedDisplayName(label: string | null, fallback: string): string {
  return typeof label === 'string' && label.trim().length > 0 && label.length <= CONNECTED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH
    ? label.trim() : fallback;
}

/** Retained V4 rows remain visible; only usable revisioned rows are selectable. */
function listedState(profile: QualifiedConnectedAccountProfileV4, authentication: PluginConnectedAccountAuthenticationV2): ConnectedAccountPurposeInventoryEntry['state'] {
  if (profile.status === 'needs_reauth') return 'reconnectRequired';
  if (!isQualifiedConnectedAccountProfileActiveV4(profile, Date.now())) {
    return typeof profile.expiresAt === 'number' && profile.expiresAt <= Date.now() ? 'expired' : 'unavailable';
  }
  return isQualifiedConnectedAccountProfileUsableV4({ profile, authentication, now: Date.now() }) ? 'connected' : 'unavailable';
}

/** Metadata projection from the finite service observation already acquired by its owner. */
export function projectConnectedAccountPurposeInventory(input: Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  authentication: PluginConnectedAccountAuthenticationV2;
  profiles: readonly QualifiedConnectedAccountProfileV4[];
}>): Readonly<{ entries: readonly ConnectedAccountPurposeInventoryEntry[] }> {
  const entries = new Map<string, ConnectedAccountPurposeInventoryEntry>();
  for (const profile of input.profiles) {
    if (profile.ref.service.pluginId !== input.service.pluginId || profile.ref.service.localId !== input.service.localId) continue;
    const account = Object.freeze({ service: Object.freeze({ ...profile.ref.service }), accountId: profile.ref.accountId });
    entries.set(inventoryKey(account), Object.freeze({ account,
      displayName: boundedDisplayName(readConnectedAccountPurposeProfileLabel(profile), account.accountId),
      state: listedState(profile, input.authentication) }));
  }
  return Object.freeze({ entries: Object.freeze([...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry)) });
}

/** Metadata-only inventory; secret acquisition is not part of this owner. */
export async function readConnectedAccountPurposeInventory(
  source: Pick<ConnectedAccountPurposeTargetSource, 'available' | 'resolveService' | 'listAccounts'>,
  input: Readonly<{ serviceRefs: readonly QualifiedConnectedAccountRef['service'][]; signal: AbortSignal }>,
): Promise<Readonly<{ entries: readonly ConnectedAccountPurposeInventoryEntry[] }>> {
  input.signal.throwIfAborted();
  const entries = new Map<string, ConnectedAccountPurposeInventoryEntry>();
  if (source.available) for (const serviceRef of input.serviceRefs) {
    const service = await source.resolveService(serviceRef, input.signal);
    if (!service) continue;
    const accounts = await source.listAccounts(service.service, input.signal, true);
    input.signal.throwIfAborted();
    for (const entry of projectConnectedAccountPurposeInventory({ ...service, profiles: accounts }).entries) {
      entries.set(inventoryKey(entry.account), entry);
    }
  }
  input.signal.throwIfAborted();
  return Object.freeze({ entries: Object.freeze([...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry)) });
}

/** Form discovery needs only authorized metadata, without acquiring a materializer. */
export async function listConnectedAccountActionFormOptions(
  source: Pick<ConnectedAccountPurposeTargetSource, 'available' | 'resolveService' | 'listAccounts'>,
  input: Readonly<{ serviceRefs: readonly QualifiedConnectedAccountRef['service'][]; signal: AbortSignal }>,
): Promise<readonly Readonly<{ value: QualifiedConnectedAccountRef; label: string }>[]> {
  const inventory = await readConnectedAccountPurposeInventory(source, input);
  const selectable = inventory.entries.filter(entry => entry.state === 'connected');
  if (selectable.length > CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND) throw new PluginError({
    code: 'plugin_ui_unavailable',
    message: 'Connected Account Action-form selection is unavailable because the authorized account inventory is too large',
  });
  return Object.freeze(selectable.map(entry => Object.freeze({ value: entry.account, label: entry.displayName })));
}
