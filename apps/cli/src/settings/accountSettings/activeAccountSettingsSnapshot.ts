import { projectSavedSecretCatalogCollisionStateV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { AccountSettings, SavedSecretCatalogCollisionStateV1 } from '@happier-dev/protocol';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { AccountSettingsProfilesSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { RemoteHostCatalogSnapshotV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { materializeExternalSessionSourceInstances, type ExternalSessionSourceDeclarationInput } from '@happier-dev/protocol/plugins/backendExternalSessionSourceInstances';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { ConnectedPresentationCatalogSnapshotV1, ConnectedAcknowledgementsCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { readPromptLibraryCatalogRecordV1, readRetainedPromptLibraryInventoryV1,
  type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type {
  SavedSecretCatalogResourceInputV1,
  SavedSecretCatalogState,
  SavedSecretLegacyImportResultV1,
} from '@/settings/secrets/savedSecretCatalog';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  rawSettings?: Readonly<Record<string, unknown>>;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: SavedSecretCatalogState;
  /** Value-free operation diagnostics; not persisted Account preferences or material readiness. */
  savedSecretLegacyImport?: SavedSecretLegacyImportResultV1;
  profileCatalog?: ProfileCatalogSnapshotV1;
  providerConnectionsCatalog?: ProviderConnectionsCatalogSnapshotV1;
  promptLibraryCatalog?: PromptLibraryCatalogSnapshotV1;
  acpCatalog?: AcpCatalogSnapshotV1;
  mcpServerCatalog?: McpServerCatalogSnapshotV1;
  connectedConfigurationCatalog?: ConnectedAccountCatalogSnapshotV1;
  connectedPurposeCatalog?: ConnectedAccountCatalogSnapshotV1;
  remoteHostCatalog?: RemoteHostCatalogSnapshotV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  connectedPresentationCatalog?: ConnectedPresentationCatalogSnapshotV1;
  connectedAcknowledgementsCatalog?: ConnectedAcknowledgementsCatalogSnapshotV1;
  scopeKey?: string;
}>;

export type ActiveAccountSettingsSnapshotListener = (
  previous: ActiveAccountSettingsSnapshot | null,
  next: ActiveAccountSettingsSnapshot | null,
) => void;

/** Host-private captured reader; current invocation producers expose their owning holder. */
export type AccountSettingsSnapshotResolver = ((input?: Readonly<{
  secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
  mcpServerCatalog?: boolean;
  savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[];
  signal?: AbortSignal;
}>) => Promise<ActiveAccountSettingsSnapshot | null>) & Readonly<{
  /** Machine-owned Run composition binds its admitted invocation's original
   * private Account holder. Session readers already capture that owner. */
  forInvocation?: (ingress?: import('@/api/rpc/types').RpcHandlerContext) => AccountSettingsSnapshotResolver;
  readOperationContext?: () => import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1 | null;
}>;

export type ActiveAccountSettingsSnapshotCommit = Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  didCommit: boolean;
}>;

let active: ActiveAccountSettingsSnapshot | null = null;
// Settled listener facts. `active` can independently withdraw several catalog
// facets during refresh; settling one facet must not publish the others.
let published: ActiveAccountSettingsSnapshot | null = null;
// This token is intentionally owner-local: Account scope or key-material
// retirement advances it; a newer preference revision alone does not.
let activeLifetimeToken = 0;
// Connected Services projections can change the configured External Session
// source set without changing Account Settings themselves.
let activeConnectedServicesProjectionRevision = 0;
const connectedServiceProjectionRevisions = new Map<string, number>();
const connectedServiceProjectionListeners = new Set<(serviceIds?: ReadonlySet<string>) => void>();
const listeners = new Set<ActiveAccountSettingsSnapshotListener>();

// Opened domains belong to the Account lifetime, not the preference revision.
const accountCatalogFields = [
  'profileCatalog', 'providerConnectionsCatalog', 'promptLibraryCatalog', 'acpCatalog', 'mcpServerCatalog',
  'connectedConfigurationCatalog', 'connectedPurposeCatalog',
  'remoteHostCatalog', 'notificationChannelCatalog', 'connectedPresentationCatalog', 'connectedAcknowledgementsCatalog',
] as const satisfies readonly (keyof ActiveAccountSettingsSnapshot)[];
const independentAccountFields = [
  ...accountCatalogFields, 'savedSecretResources', 'savedSecretCatalogState',
] as const satisfies readonly (keyof ActiveAccountSettingsSnapshot)[];

function zeroRetiredSavedSecretResourceDataKeys(
  previous: readonly SavedSecretCatalogResourceInputV1[] | undefined,
  next: readonly SavedSecretCatalogResourceInputV1[] | undefined,
): void {
  if (!previous) return;
  const retainedKeys = new Set(
    (next ?? []).flatMap((resource) => resource.resourceDataKey ? [resource.resourceDataKey] : []),
  );
  for (const resource of previous) {
    if (resource.resourceDataKey && !retainedKeys.has(resource.resourceDataKey)) {
      resource.resourceDataKey.fill(0);
    }
  }
}

function belongsToSameAccount(
  previous: ActiveAccountSettingsSnapshot,
  next: ActiveAccountSettingsSnapshot,
): boolean {
  if (previous.scopeKey && next.scopeKey) {
    return previous.scopeKey === next.scopeKey;
  }
  // An unscoped replacement cannot prove that it belongs to the same Account.
  return previous === next;
}

function emitActiveAccountSettingsSnapshot(
  next: ActiveAccountSettingsSnapshot | null,
): void {
  const previous = published;
  published = next;
  if (previous && next && belongsToSameAccount(previous, next)
    && (previous.source === 'none') === (next.source === 'none')) {
    // Revision and timing advance synchronous admission without replacing
    // consumed facts. Source transitions still change read authority.
    const { settingsVersion: _previousVersion, loadedAtMs: _previousLoadedAt, ...previousFacts } = previous;
    const { settingsVersion: _nextVersion, loadedAtMs: _nextLoadedAt, ...nextFacts } = next;
    if (isDeepStrictEqual(previousFacts, nextFacts)) return;
  }
  for (const listener of listeners) {
    try {
      listener(previous, next);
    } catch {
      // The accepted local winner must not roll back because a consumer wake failed.
    }
  }
}

/** Settle only the observed facets; synchronous admission still reads `active`. */
function publishSettledAccountCatalog(
  next: ActiveAccountSettingsSnapshot,
  facets: readonly typeof independentAccountFields[number][],
  unchanged: boolean,
): void {
  const publication = published && belongsToSameAccount(published, next)
    ? { ...published, ...Object.fromEntries(facets.map(facet => [facet, next[facet]])) }
    : next;
  if (unchanged) published = publication;
  else emitActiveAccountSettingsSnapshot(publication);
}

/** An unrelated preference write does not replace unchanged admitted values. */
function preserveEqualPreferenceValues<T extends object>(previous: T, next: T): T {
  if (previous === next) return next;
  const keys = Object.keys(next) as (keyof T)[];
  let shared = next;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(previous, key) || Object.is(previous[key], next[key])) continue;
    if (isDeepStrictEqual(previous[key], next[key])) {
      if (shared === next) shared = { ...next };
      shared[key] = previous[key];
    }
  }
  return Object.keys(previous).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(previous, key) && Object.is(previous[key], shared[key]))
    ? previous : shared;
}

/** One inheritance policy for daemon and issued-invocation preference refreshes. */
export function preserveAccountCatalogsInSnapshot(
  previous: ActiveAccountSettingsSnapshot | null,
  next: ActiveAccountSettingsSnapshot,
  previousSource?: ActiveAccountSettingsSnapshot | null,
): ActiveAccountSettingsSnapshot {
  // A captured reader can hydrate domains privately. Refreshing its source's
  // preferences or another domain must retain those reads when the source did
  // not change that domain; an actual source change still wins.
  const sourceUnchangedAccount = previousSource && belongsToSameAccount(previousSource, next);
  const inherited = previous && belongsToSameAccount(previous, next)
    ? independentAccountFields.filter(field => (next[field] === undefined
      || sourceUnchangedAccount && next[field] === previousSource[field]) && previous[field] !== undefined)
    : [];
  let accepted: ActiveAccountSettingsSnapshot = inherited.length > 0 && previous
    ? { ...next, ...Object.fromEntries(inherited.map(field => [field, previous[field]])) }
    : next;
  if (previous && belongsToSameAccount(previous, accepted)) {
    // A private source read can be newer than the ambient Settings underneath
    // an independent catalog publication. Keep that accepted Settings read,
    // while catalogs and current key material still reconcile from the source.
    if (accepted.settingsVersion < previous.settingsVersion) {
      accepted = { ...accepted, source: previous.source, settings: previous.settings,
        rawSettings: previous.rawSettings, settingsVersion: previous.settingsVersion, loadedAtMs: previous.loadedAtMs };
    }
    // A newer observation can advance revision/timing without changing the
    // preferences or material consumed by an admitted operation.
    const settings = preserveEqualPreferenceValues(previous.settings, accepted.settings);
    const rawSettings = previous.rawSettings && accepted.rawSettings
      ? preserveEqualPreferenceValues(previous.rawSettings, accepted.rawSettings) : accepted.rawSettings;
    const settingsSecretsReadKeys = isDeepStrictEqual(previous.settingsSecretsReadKeys, accepted.settingsSecretsReadKeys)
      ? previous.settingsSecretsReadKeys : accepted.settingsSecretsReadKeys;
    if (settings !== accepted.settings || rawSettings !== accepted.rawSettings
      || settingsSecretsReadKeys !== accepted.settingsSecretsReadKeys) {
      accepted = { ...accepted, settings, settingsSecretsReadKeys,
        ...(rawSettings !== accepted.rawSettings ? { rawSettings } : {}) };
    }
    for (const field of ['connectedConfigurationCatalog', 'connectedPurposeCatalog'] as const) {
      const catalog = accepted[field];
      if (catalog?.status === 'ready') accepted = { ...accepted,
        [field]: preserveConnectedAccountCatalogCleanup(previous[field], catalog) };
    }
    if (accepted.providerConnectionsCatalog && accepted.providerConnectionsCatalog !== previous.providerConnectionsCatalog) accepted = { ...accepted,
      providerConnectionsCatalog: preserveProviderConnectionsCatalogAuthority(
        previous.providerConnectionsCatalog, accepted.providerConnectionsCatalog),
    };
  }
  if (previous && belongsToSameAccount(previous, accepted)
    && !isDeepStrictEqual(previous.settingsSecretsReadKeys, accepted.settingsSecretsReadKeys)) {
    accepted = {
      ...accepted,
      ...(previous.mcpServerCatalog !== undefined ? { mcpServerCatalog: { status: 'loading' as const } } : {}),
      ...(previous.providerConnectionsCatalog !== undefined ? { providerConnectionsCatalog: { status: 'loading' as const } } : {}),
      ...(previous.connectedConfigurationCatalog !== undefined ? { connectedConfigurationCatalog: { status: 'loading' as const } } : {}),
      ...(previous.connectedPurposeCatalog !== undefined ? { connectedPurposeCatalog: { status: 'loading' as const } } : {}),
      ...(previous.remoteHostCatalog !== undefined ? { remoteHostCatalog: { status: 'loading' as const } } : {}),
      ...(previous.notificationChannelCatalog !== undefined ? { notificationChannelCatalog: { status: 'loading' as const } } : {}),
      ...(previous.connectedPresentationCatalog !== undefined ? { connectedPresentationCatalog: { status: 'loading' as const } } : {}),
      ...(previous.connectedAcknowledgementsCatalog !== undefined ? { connectedAcknowledgementsCatalog: { status: 'loading' as const } } : {}),
    };
  }
  if (previous && belongsToSameAccount(previous, accepted) && previous.acpCatalog !== undefined
    && (!isDeepStrictEqual(previous.settingsSecretsReadKeys, accepted.settingsSecretsReadKeys)
      || accepted.acpCatalog?.status === 'ready' && accepted.acpCatalog.revision === 'absent'
        && accepted.acpCatalog.sourceSettingsVersion !== accepted.settingsVersion)) {
    accepted = { ...accepted, acpCatalog: { status: 'loading' } };
  }
  return accepted;
}

/** The sole process-local publication cut for account settings. */
export function commitActiveAccountSettingsSnapshot(
  next: ActiveAccountSettingsSnapshot,
): ActiveAccountSettingsSnapshotCommit {
  const previous = active;
  if (
    previous?.scopeKey
    && next.scopeKey === previous.scopeKey
    && next.settingsVersion <= previous.settingsVersion
    // A first network read can confirm the cached revision (including empty
    // version zero). Accept that provenance while retaining unchanged values.
    && !(next.settingsVersion === previous.settingsVersion && previous.source !== 'network'
      && next.source === 'network' && next.rawSettings !== undefined)
  ) {
    return { snapshot: previous, didCommit: false };
  }
  const accepted = preserveAccountCatalogsInSnapshot(previous, next);
  zeroRetiredSavedSecretResourceDataKeys(previous?.savedSecretResources, accepted.savedSecretResources);
  active = accepted;
  const lifetimeChanged = !previous || !belongsToSameAccount(previous, accepted)
    || !isDeepStrictEqual(previous.settingsSecretsReadKeys, accepted.settingsSecretsReadKeys);
  if (lifetimeChanged) {
    activeLifetimeToken += 1;
    connectedServiceProjectionRevisions.clear();
    activeConnectedServicesProjectionRevision = 0;
  }
  // Settings cannot settle another owner's in-flight catalog observation.
  // Key retirement and Account replacement still publish their withdrawal.
  const settled = published;
  const retained = !lifetimeChanged && settled
    ? independentAccountFields.filter(field => accepted[field] !== settled[field]) : [];
  const publication = retained.length > 0 && settled
    ? { ...accepted, ...Object.fromEntries(retained.map(field => [field, settled[field]])) }
    : accepted;
  emitActiveAccountSettingsSnapshot(publication);
  return { snapshot: accepted, didCommit: true };
}

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  commitActiveAccountSettingsSnapshot(next);
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

/** The existing Account publication owner carries ACP row revisions independently of preferences. */
export function commitActiveAcpCatalog(input: Readonly<{
  scopeKey: string; lifetimeToken: number; catalog: AcpCatalogSnapshotV1;
}>): boolean {
  const previous = active;
  if (!previous || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) return false;
  if (input.catalog.status === 'ready' && input.catalog.revision === 'absent'
    && input.catalog.sourceSettingsVersion !== previous.settingsVersion) return false;
  if (input.catalog.status === 'ready' && typeof input.catalog.revision === 'number'
    && published?.scopeKey === input.scopeKey && published.acpCatalog?.status === 'ready' && typeof published.acpCatalog.revision === 'number'
    && input.catalog.revision < published.acpCatalog.revision) return false;
  const unchanged = published?.scopeKey === input.scopeKey && isDeepStrictEqual(published.acpCatalog, input.catalog);
  const catalog = unchanged ? published!.acpCatalog! : input.catalog;
  if (unchanged && previous.acpCatalog === catalog && published?.settings === previous.settings) return true;
  const next = { ...previous, acpCatalog: catalog };
  active = next;
  publishSettledAccountCatalog(next, ['acpCatalog'], unchanged);
  return true;
}

export function beginActiveAcpCatalogRefresh(input: Readonly<{ scopeKey: string; lifetimeToken: number }>): boolean {
  if (!active || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) return false;
  active = { ...active, acpCatalog: { status: 'loading' } };
  return true;
}

export function readActiveAcpCatalog(): AcpCatalogSnapshotV1 {
  return active?.acpCatalog ?? { status: 'unavailable', reason: 'catalog-unobserved' };
}

/** Pure Account-catalog projection; Settings remains the sole persisted owner. */
export function resolveActiveSavedSecretCatalogCollisionState(
  snapshot: ActiveAccountSettingsSnapshot,
): SavedSecretCatalogCollisionStateV1 {
  return projectSavedSecretCatalogCollisionStateV1(snapshot.settings.secrets);
}

/**
 * Identifies the current process-local Account incumbent.  Consumers that bind
 * authority across async work must capture this token, rather than treating a
 * matching scope key as proof that a retired Account lifetime is current again.
 */
export function getActiveAccountSettingsSnapshotLifetimeToken(): number {
  return activeLifetimeToken;
}

/** Admission to the original Account lifetime, independent of catalog availability. */
export function isActiveAccountSettingsSnapshotLifetimeCurrent(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return active !== null && active.scopeKey === input.scopeKey && activeLifetimeToken === input.lifetimeToken;
}

/** Retained Settings source until the catalog transfer; the Account lifetime owns admission. */
export function readActiveAccountRoleOverrides(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): AccountRoleOverridesReadV1 {
  if (!active || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) {
    return { status: 'unavailable', reason: 'scope-retired' };
  }
  return readAccountRoleOverridesFromSnapshot(active);
}

/** Reads the same canonical retained/catalog representation for a finite requester snapshot. */
export function readAccountRoleOverridesFromSnapshot(active: ActiveAccountSettingsSnapshot): AccountRoleOverridesReadV1 {
  if (!active.promptLibraryCatalog) return { status: 'unavailable', reason: 'catalog-unobserved' };
  const read = readPromptLibraryCatalogRecordV1({ catalog: active.promptLibraryCatalog, key: 'role-overrides',
    rawSettings: active.source === 'none' ? undefined : active.rawSettings });
  if (read.status !== 'ready') return read;
  return read.record.key === 'role-overrides' ? { status: 'ready', overrides: read.record.value.overrides }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

export type ActiveAccountPromptStackSources =
  | Readonly<{ status: 'ready'; accountEntries: readonly PromptStackEntryV1[]; profileEntries: readonly PromptStackEntryV1[] }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

/** Current process-local source port for the canonical four-layer resolver. */
type AccountPromptStackSourceSelection = Readonly<{
  surface: 'coding' | 'voice';
  profileId?: string | null;
  /** Retained Session exclusions need row identity even when that Profile is now disabled. */
  profilePurpose?: 'active_context' | 'retained_exclusions';
  /** The canonical opened selection read, captured within this same Account lifetime. */
  profilesSnapshot?: AccountSettingsProfilesSnapshot;
}>;

export function readActiveAccountPromptStackSources(input: AccountPromptStackSourceSelection & Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): ActiveAccountPromptStackSources {
  if (!active || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) {
    return { status: 'unavailable', reason: 'scope-retired' };
  }
  return readAccountPromptStackSources(active, input);
}

/** The same row custody reader serves active and privately captured Accounts. */
export function readAccountPromptStackSources(snapshot: ActiveAccountSettingsSnapshot,
  input: AccountPromptStackSourceSelection): ActiveAccountPromptStackSources {
  if (!snapshot.promptLibraryCatalog) return { status: 'unavailable', reason: 'catalog-unobserved' };
  const read = readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog, key: input.surface,
    rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings });
  if (read.status !== 'ready') return read;
  if (read.record.key !== 'coding' && read.record.key !== 'voice') return { status: 'unavailable', reason: 'invalid-stored-content' };
  const accountEntries = read.record.value.entries;
  const profile = readAccountProfilePromptStackSources(snapshot, input);
  return profile.status === 'ready' ? { ...profile, accountEntries } : profile;
}

/** Selected Profile custody does not depend on an optional Account surface row. */
export function readAccountProfilePromptStackSources(snapshot: ActiveAccountSettingsSnapshot,
  input: Pick<AccountPromptStackSourceSelection, 'profileId' | 'profilePurpose' | 'profilesSnapshot'>):
  Readonly<{ status: 'ready'; profileEntries: readonly PromptStackEntryV1[] }> | Readonly<{ status: 'unavailable'; reason: string }> {
  let profileEntries: readonly PromptStackEntryV1[] = [];
  let useRetainedProfileStack = Boolean(input.profileId);
  if (input.profileId && snapshot.profileCatalog) {
    const catalog = snapshot.profileCatalog;
    if (catalog.status !== 'ready') return { status: 'unavailable', reason: catalog.status === 'unavailable' ? catalog.reason : 'profile-catalog-incomplete' };
    if (catalog.authority === 'active' || catalog.source === 'destination') {
      const selected = catalog.records.find(({ record }) => record.id === input.profileId);
      if (selected) {
        if (!selected.record.enabled && input.profilePurpose !== 'retained_exclusions') {
          return { status: 'unavailable', reason: 'profile-target-unavailable' };
        }
        profileEntries = selected.record.promptStack;
      } else {
        const visible = input.profilesSnapshot?.visibleProfiles.filter(profile => profile.id === input.profileId);
        const profile = visible?.length === 1 ? visible[0] : undefined;
        if (!profile || profile.profileRecordRevision !== undefined || profile.enabled === false
          || input.profilesSnapshot?.enabledByProfileId[input.profileId] === false) {
          return { status: 'unavailable', reason: 'profile-target-unavailable' };
        }
        // Grants and builtin presets can be real selections without a private
        // membership row. Their opened public Profile supplies the layer; row
        // absence alone and retained Settings roots never authorize it.
        profileEntries = profile.promptStack ?? [];
      }
      useRetainedProfileStack = false;
    }
  }
  if (useRetainedProfileStack && input.profileId) {
    if (snapshot.source === 'none' || !snapshot.rawSettings) return { status: 'unavailable', reason: 'source-unavailable' };
    const retained = readRetainedPromptLibraryInventoryV1(snapshot.rawSettings);
    if (retained.diagnostics.some(({ key }) => key === 'coding' || key === 'voice')) return { status: 'unavailable', reason: 'invalid-stored-content' };
    profileEntries = retained.profileStacksById[input.profileId] ?? [];
  }
  return { status: 'ready', profileEntries };
}

type AccountCatalogFacet = typeof accountCatalogFields[number];
type AccountCatalogIncumbent = Readonly<{ scopeKey: string; lifetimeToken: number }>;

/** One publication policy for opened domain catalogs within the same Account lifetime. */
function commitActiveAccountCatalog<Key extends AccountCatalogFacet>(input: AccountCatalogIncumbent & Readonly<{
  facet: Key; catalog: NonNullable<ActiveAccountSettingsSnapshot[Key]>;
}>): boolean {
  const previous = active;
  if (!previous || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) return false;
  const incumbent = published?.scopeKey === input.scopeKey ? published[input.facet] : undefined;
  const unchanged = incumbent !== undefined && JSON.stringify(incumbent) === JSON.stringify(input.catalog);
  // Finishing a readable catalog phase must not withdraw consumers of that same snapshot.
  if (unchanged && previous[input.facet] === incumbent && published?.settings === previous.settings) return true;
  const next: ActiveAccountSettingsSnapshot = { ...previous, [input.facet]: unchanged ? incumbent : input.catalog };
  active = next;
  publishSettledAccountCatalog(next, [input.facet], unchanged);
  return true;
}

function beginActiveAccountCatalogRefresh(input: AccountCatalogIncumbent, facet: AccountCatalogFacet): boolean {
  if (!active || !isActiveAccountSettingsSnapshotLifetimeCurrent(input)) return false;
  active = { ...active, [facet]: { status: 'loading' } };
  return true;
}

/** Catalog refresh shares the Account publication owner, not the Settings version. */
export function commitActivePromptLibraryCatalog(input: Readonly<{
  scopeKey: string; lifetimeToken: number; catalog: PromptLibraryCatalogSnapshotV1;
}>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'promptLibraryCatalog' });
}

export function beginActivePromptLibraryCatalogRefresh(input: Readonly<{ scopeKey: string; lifetimeToken: number }>): boolean {
  return beginActiveAccountCatalogRefresh(input, 'promptLibraryCatalog');
}

export function readActivePromptLibraryCatalog(): PromptLibraryCatalogSnapshotV1 {
  return active?.promptLibraryCatalog ?? { status: 'loading' };
}

export function commitActiveMcpServerCatalog(input: AccountCatalogIncumbent & Readonly<{
  catalog: McpServerCatalogSnapshotV1;
}>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'mcpServerCatalog' });
}

export function beginActiveMcpServerCatalogRefresh(input: AccountCatalogIncumbent): boolean {
  return beginActiveAccountCatalogRefresh(input, 'mcpServerCatalog');
}

export function readActiveMcpServerCatalog(): McpServerCatalogSnapshotV1 {
  return active?.mcpServerCatalog ?? { status: 'loading' };
}

/** Change only the typed Profile facet; Account preferences and their revision stay untouched. */
export function replaceProfileCatalogInSnapshot(snapshot: ActiveAccountSettingsSnapshot,
  catalog: ProfileCatalogSnapshotV1): ActiveAccountSettingsSnapshot {
  return { ...snapshot, profileCatalog: catalog };
}

/** Same Account publication cut, independent of the preference-document revision. */
export function commitActiveProfileCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
  catalog: ProfileCatalogSnapshotV1;
}>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'profileCatalog' });
}

/** Withdraw runtime admission synchronously while the existing loader reobserves its Home. */
export function beginActiveProfileCatalogRefresh(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return beginActiveAccountCatalogRefresh(input, 'profileCatalog');
}

export function readActiveProfileCatalog(): ProfileCatalogSnapshotV1 {
  return active?.profileCatalog ?? { status: 'loading' };
}

export function readConnectedAccountCatalogFromSnapshot(snapshot: ActiveAccountSettingsSnapshot | null,
  key: ConnectedAccountCatalogKeyV1): ConnectedAccountCatalogSnapshotV1 {
  return (key === 'configurations' ? snapshot?.connectedConfigurationCatalog : snapshot?.connectedPurposeCatalog)
    ?? { status: 'loading' };
}

/** A row reobservation precedes cleanup; omitted phase metadata cannot erase the same row's observed outcome. */
export function preserveConnectedAccountCatalogCleanup(
  previous: ConnectedAccountCatalogSnapshotV1 | undefined,
  next: ConnectedAccountCatalogSnapshotV1,
): ConnectedAccountCatalogSnapshotV1 {
  if (previous === next) return next;
  if (previous?.status !== 'ready' || next.status !== 'ready'
    || !isDeepStrictEqual(previous.record, next.record)) return next;
  return { ...next, record: previous.record,
    ...(previous.cleanup !== undefined && next.cleanup === undefined && previous.revision === next.revision
      ? { cleanup: previous.cleanup } : {}) };
}

/** The row revision is independent of Account preferences; the existing Account lifetime owns publication. */
export function commitActiveConnectedAccountCatalog(input: Readonly<{
  scopeKey: string; lifetimeToken: number; key: ConnectedAccountCatalogKeyV1; catalog: ConnectedAccountCatalogSnapshotV1;
}>): boolean {
  if (!active || active.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken
    || input.catalog.status === 'ready' && input.catalog.record.key !== input.key) return false;
  const incumbent = published?.scopeKey === input.scopeKey
    ? readConnectedAccountCatalogFromSnapshot(published, input.key) : undefined;
  const observed = preserveConnectedAccountCatalogCleanup(incumbent, input.catalog);
  const unchanged = incumbent !== undefined && isDeepStrictEqual(incumbent, observed);
  const catalog = unchanged ? incumbent : observed;
  const next = input.key === 'configurations' ? { ...active, connectedConfigurationCatalog: catalog }
    : { ...active, connectedPurposeCatalog: catalog };
  active = next;
  publishSettledAccountCatalog(next,
    [input.key === 'configurations' ? 'connectedConfigurationCatalog' : 'connectedPurposeCatalog'], unchanged);
  return true;
}

/** Withdraw admission while a row hint is reobserved, without emitting a transient empty choice. */
export function beginActiveConnectedAccountCatalogRefresh(input: Readonly<{
  scopeKey: string; lifetimeToken: number; key: ConnectedAccountCatalogKeyV1;
}>): boolean {
  if (!active || active.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken) return false;
  active = input.key === 'configurations' ? { ...active, connectedConfigurationCatalog: { status: 'loading' } }
    : { ...active, connectedPurposeCatalog: { status: 'loading' } };
  return true;
}

function preserveProviderConnectionsCatalogAuthority(
  incumbent: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'],
  next: ProviderConnectionsCatalogSnapshotV1,
): ProviderConnectionsCatalogSnapshotV1 {
  // Cleanup is not a new row authority. Keep the admitted catalog identity
  // when a reobserved equal row gains its independent maintenance outcome.
  return incumbent?.status === 'ready' && next.status === 'ready'
    && incumbent.revision === next.revision && isDeepStrictEqual(incumbent.catalog, next.catalog)
    ? { ...next, catalog: incumbent.catalog }
    : next;
}

/** Change the Provider facet without serializing a domain mirror in preferences. */
export function replaceProviderConnectionsCatalogInSnapshot(snapshot: ActiveAccountSettingsSnapshot,
  catalog: ProviderConnectionsCatalogSnapshotV1): ActiveAccountSettingsSnapshot {
  return { ...snapshot, providerConnectionsCatalog: preserveProviderConnectionsCatalogAuthority(snapshot.providerConnectionsCatalog, catalog) };
}

export function commitActiveProviderConnectionsCatalog(input: Readonly<{
  scopeKey: string; lifetimeToken: number; catalog: ProviderConnectionsCatalogSnapshotV1;
}>): boolean {
  const incumbent = published?.scopeKey === input.scopeKey ? published.providerConnectionsCatalog : undefined;
  const catalog = preserveProviderConnectionsCatalogAuthority(incumbent, input.catalog);
  return commitActiveAccountCatalog({ ...input, catalog, facet: 'providerConnectionsCatalog' });
}

export function beginActiveProviderConnectionsCatalogRefresh(input: Readonly<{ scopeKey: string; lifetimeToken: number }>): boolean {
  return beginActiveAccountCatalogRefresh(input, 'providerConnectionsCatalog');
}

export function readActiveProviderConnectionsCatalog(): ProviderConnectionsCatalogSnapshotV1 {
  return active?.providerConnectionsCatalog ?? { status: 'loading' };
}

export function commitActiveRemoteHostCatalog(input: AccountCatalogIncumbent & Readonly<{ catalog: RemoteHostCatalogSnapshotV1 }>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'remoteHostCatalog' });
}

export function beginActiveRemoteHostCatalogRefresh(input: AccountCatalogIncumbent): boolean {
  return beginActiveAccountCatalogRefresh(input, 'remoteHostCatalog');
}

export function readActiveRemoteHostCatalog(): RemoteHostCatalogSnapshotV1 {
  return active?.remoteHostCatalog ?? { status: 'loading' };
}

export function commitActiveNotificationChannelCatalog(input: AccountCatalogIncumbent & Readonly<{ catalog: NotificationChannelCatalogSnapshotV1 }>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'notificationChannelCatalog' });
}

/** Finite requester publication never mutates the daemon Account incumbent. */
export function replaceNotificationChannelCatalogInSnapshot(snapshot: ActiveAccountSettingsSnapshot,
  catalog: NotificationChannelCatalogSnapshotV1): ActiveAccountSettingsSnapshot {
  return { ...snapshot, notificationChannelCatalog: catalog };
}

export function beginActiveNotificationChannelCatalogRefresh(input: AccountCatalogIncumbent): boolean {
  return beginActiveAccountCatalogRefresh(input, 'notificationChannelCatalog');
}

export function readActiveNotificationChannelCatalog(): NotificationChannelCatalogSnapshotV1 {
  return active?.notificationChannelCatalog ?? { status: 'loading' };
}

export function commitActiveConnectedPresentationCatalog(input: AccountCatalogIncumbent & Readonly<{ catalog: ConnectedPresentationCatalogSnapshotV1 }>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'connectedPresentationCatalog' });
}

export function beginActiveConnectedPresentationCatalogRefresh(input: AccountCatalogIncumbent): boolean {
  return beginActiveAccountCatalogRefresh(input, 'connectedPresentationCatalog');
}

export function readActiveConnectedPresentationCatalog(): ConnectedPresentationCatalogSnapshotV1 {
  return active?.connectedPresentationCatalog ?? { status: 'loading' };
}

export function commitActiveConnectedAcknowledgementsCatalog(input: AccountCatalogIncumbent & Readonly<{ catalog: ConnectedAcknowledgementsCatalogSnapshotV1 }>): boolean {
  return commitActiveAccountCatalog({ ...input, facet: 'connectedAcknowledgementsCatalog' });
}

export function beginActiveConnectedAcknowledgementsCatalogRefresh(input: AccountCatalogIncumbent): boolean {
  return beginActiveAccountCatalogRefresh(input, 'connectedAcknowledgementsCatalog');
}

export function readActiveConnectedAcknowledgementsCatalog(): ConnectedAcknowledgementsCatalogSnapshotV1 {
  return active?.connectedAcknowledgementsCatalog ?? { status: 'loading' };
}

/** Only the transient import outcome changes; raw preferences, version and keys retain identity. */
export function replaceSavedSecretLegacyImportInSnapshot(snapshot: ActiveAccountSettingsSnapshot,
  result: SavedSecretLegacyImportResultV1): ActiveAccountSettingsSnapshot {
  if (JSON.stringify(snapshot.savedSecretLegacyImport) === JSON.stringify(result)) return snapshot;
  return { ...snapshot, savedSecretLegacyImport: result };
}

export function commitActiveSavedSecretLegacyImport(input: Readonly<{
  scopeKey: string; lifetimeToken: number; expectedSettingsVersion: number; result: SavedSecretLegacyImportResultV1;
}>): boolean {
  if (!active || active.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken
    || active.settingsVersion !== input.expectedSettingsVersion) return false;
  const previous = active;
  const next = replaceSavedSecretLegacyImportInSnapshot(active, input.result);
  active = next;
  // Operation callers read the diagnostic from the returned/current snapshot.
  // A cleanup result is not a material change and must not restart Sessions.
  if (published === previous) published = next;
  return true;
}

/** Publishes a resource-catalog refresh without pretending Settings advanced. */
export function commitActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
  resources: readonly SavedSecretCatalogResourceInputV1[];
  state: SavedSecretCatalogState;
}>): boolean {
  const previous = active;
  if (!previous || previous.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken) return false;
  const next = replaceSavedSecretCatalogInSnapshot(previous, input);
  active = next;
  publishSavedSecretCatalogIfChanged(next);
  return true;
}

/** Same material retirement for active Account and invocation-local custody. */
export function replaceSavedSecretCatalogInSnapshot(
  snapshot: ActiveAccountSettingsSnapshot,
  input: Readonly<{ resources: readonly SavedSecretCatalogResourceInputV1[]; state: SavedSecretCatalogState }>,
): ActiveAccountSettingsSnapshot {
  zeroRetiredSavedSecretResourceDataKeys(snapshot.savedSecretResources, input.resources);
  return { ...snapshot, savedSecretResources: input.resources, savedSecretCatalogState: input.state };
}

export function withdrawSavedSecretCatalogInSnapshot(snapshot: ActiveAccountSettingsSnapshot): ActiveAccountSettingsSnapshot {
  const resources = (snapshot.savedSecretResources ?? []).map(({ resourceDataKey, ...resource }) => {
    resourceDataKey?.fill(0);
    return { ...resource, storedContent: null };
  });
  return replaceSavedSecretCatalogInSnapshot(snapshot, { resources, state: 'temporarily_unavailable' });
}

function withdrawSavedSecretCatalogMaterial(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): ActiveAccountSettingsSnapshot | null {
  const previous = active;
  if (!previous || previous.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken) return null;
  const next = withdrawSavedSecretCatalogInSnapshot(previous);
  active = next;
  return next;
}

/**
 * The listener-visible content of a catalog publication. Opened resource DEKs
 * are derived from the row's envelope and change only with its stored content,
 * so only their presence is part of the logical catalog.
 */
function savedSecretCatalogPublicationKey(snapshot: ActiveAccountSettingsSnapshot): string {
  return JSON.stringify([
    snapshot.savedSecretCatalogState ?? null,
    (snapshot.savedSecretResources ?? []).map(({ resourceDataKey, ...resource }) => [
      resource,
      resourceDataKey !== undefined,
    ]),
  ]);
}

/**
 * A catalog refresh re-observes the Home on every AccountChange wake and every
 * operation admission. Listeners restart Sessions and prepare direct material,
 * so they are woken only when the authorized catalog actually changed
 * (teams-lane-10 08 §5.8; 06 L10D-R13).
 */
function publishSavedSecretCatalogIfChanged(next: ActiveAccountSettingsSnapshot): void {
  const unchanged = Boolean(
    published
    && published.scopeKey === next.scopeKey
    && published.settings === next.settings
    && savedSecretCatalogPublicationKey(published) === savedSecretCatalogPublicationKey(next)
  );
  publishSettledAccountCatalog(next, ['savedSecretResources', 'savedSecretCatalogState'], unchanged);
}

/**
 * Starts a catalog refresh: a refresh is an authorization observation boundary,
 * so opened material is retired before waiting on the Home and synchronous
 * readers fail closed meanwhile. Nothing is published here; the refresh
 * publishes its outcome once, through `commitActiveSavedSecretCatalog` or
 * `withdrawActiveSavedSecretCatalog`, and only if it differs from what
 * listeners last observed.
 */
export function beginActiveSavedSecretCatalogRefresh(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return withdrawSavedSecretCatalogMaterial(input) !== null;
}

/**
 * Fails shared material closed when the Home can no longer be observed while
 * retaining only repairable metadata for retry UX.
 */
export function withdrawActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  const next = withdrawSavedSecretCatalogMaterial(input);
  if (!next) return false;
  publishSavedSecretCatalogIfChanged(next);
  return true;
}

/** Retires all shared material and metadata when the Teams master feature is disabled. */
export function disableActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return commitActiveSavedSecretCatalog({
    ...input,
    resources: Object.freeze([]),
    state: 'disabled',
  });
}

/**
 * Revokes the current process-local Account Settings incumbent at logout.
 * Subscribers observe this transition so custody bound to the prior Account
 * cannot become current again if that Account is later selected anew.
 */
export function clearActiveAccountSettingsSnapshot(): void {
  const previous = active;
  if (!previous) return;
  zeroRetiredSavedSecretResourceDataKeys(previous.savedSecretResources, undefined);
  active = null;
  activeLifetimeToken += 1;
  connectedServiceProjectionRevisions.clear();
  activeConnectedServicesProjectionRevision = 0;
  emitActiveAccountSettingsSnapshot(null);
}

export function resolveActiveAccountSettingsSnapshotRevision(
  snapshot: ActiveAccountSettingsSnapshot | null,
): string {
  if (!snapshot) return 'account-profile:bootstrap';
  return [
    snapshot.scopeKey ?? 'active',
    snapshot.settingsVersion,
    snapshot.loadedAtMs,
    snapshot.profileCatalog?.status ?? 'profiles-unobserved',
    snapshot.profileCatalog?.status === 'ready' || snapshot.profileCatalog?.status === 'partial'
      ? snapshot.profileCatalog.referenceGuardRevision : '',
    snapshot.profileCatalog?.status === 'ready' || snapshot.profileCatalog?.status === 'partial'
      ? `${snapshot.profileCatalog.authority}:${snapshot.profileCatalog.controlRevision}:${snapshot.profileCatalog.source ?? ''}` : '',
    snapshot.promptLibraryCatalog?.status ?? 'prompts-unobserved',
    snapshot.promptLibraryCatalog?.status === 'ready' || snapshot.promptLibraryCatalog?.status === 'partial'
      ? JSON.stringify([snapshot.promptLibraryCatalog.rows.map(({ record, revision }) => [record.key, revision]),
        snapshot.promptLibraryCatalog.tombstones, snapshot.promptLibraryCatalog.diagnostics]) : '',
    snapshot.providerConnectionsCatalog?.status ?? 'providers-unobserved',
    snapshot.providerConnectionsCatalog?.status === 'ready' || snapshot.providerConnectionsCatalog?.status === 'partial'
      ? snapshot.providerConnectionsCatalog.revision : '',
    snapshot.mcpServerCatalog?.status ?? 'mcp-unobserved',
    snapshot.mcpServerCatalog?.status === 'ready' || snapshot.mcpServerCatalog?.status === 'partial'
      ? `${snapshot.mcpServerCatalog.authority}:${snapshot.mcpServerCatalog.revision}` : '',
  ].join(':');
}

/**
 * Configured sources consume declared source settings and Connected Services, not
 * the independently hydrated Profile, Prompt, Provider or MCP catalogs. A
 * catalog publication or a newer read timestamp must not retire a live native
 * transcript follower. Keep actual source/availability changes and Account
 * lifetime or Connected Services revocation in the existing source lifecycle.
 */
export function resolveActiveAccountConfiguredExternalSessionSourceRevision(
  snapshot: ActiveAccountSettingsSnapshot | null,
  sources: readonly ExternalSessionSourceDeclarationInput[] = [],
  activeServerId: string | null = null,
): string {
  const sourceSettings = sources.filter(source => source.instances?.some(instance =>
    instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride')).map(declaration =>
    materializeExternalSessionSourceInstances({ declaration, agentSettings: snapshot?.settings, activeServerId }));
  // Key withdrawal must still fence retained source reads. Private source
  // settings and key material must not appear in revision diagnostics.
  const facts = createHash('sha256').update(JSON.stringify(sourceSettings));
  for (const key of snapshot?.settingsSecretsReadKeys ?? []) facts.update(`${key.length}:`).update(key);
  const services = configuredExternalSessionSourceServiceIds(sources);
  return [
    snapshot
      ? `${snapshot.scopeKey ?? 'active'}:${snapshot.source === 'none' ? 'unavailable' : 'available'}`
      : 'account-profile:bootstrap',
    facts.digest('hex'),
    'connected-services',
    activeLifetimeToken,
    services.size > 0 ? activeConnectedServicesProjectionRevision : 0,
    ...Array.from(services).sort().map(serviceId => `${serviceId}:${connectedServiceProjectionRevisions.get(serviceId) ?? 0}`),
  ].join(':');
}

function configuredExternalSessionSourceServiceIds(sources: readonly ExternalSessionSourceDeclarationInput[]): ReadonlySet<string> {
  return new Set(sources.flatMap(source => (source.instances ?? []).flatMap(instance =>
    instance.kind === 'connectedServiceProfiles' && typeof instance.serviceId === 'string' ? [instance.serviceId] : [])));
}

/** Account preference roots consumed by declaration-owned native source instances. */
export function configuredExternalSessionSourceSettingsKeys(
  sources: readonly ExternalSessionSourceDeclarationInput[],
): readonly string[] {
  return [...new Set(sources.flatMap(source => (source.instances ?? []).flatMap(instance =>
    instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride'
      ? [instance.settingId, instance.byServerIdSettingId].filter((key): key is string => typeof key === 'string')
      : [])))];
}

/**
 * Projection changes retire only the configured sources consuming that service.
 * They do not change Settings or settle independently refreshing catalogs.
 */
export function notifyActiveAccountConnectedServicesProjection(scopeKey: string,
  connectedServiceRefs?: readonly QualifiedConnectedAccountRef['service'][]): void {
  const snapshot = active;
  if (snapshot?.scopeKey && snapshot.scopeKey !== scopeKey) return;
  // Configured source declarations currently consume the scalar projection.
  // Use its canonical identity translator; novel services cannot affect it.
  const serviceIds = connectedServiceRefs === undefined ? undefined : new Set(connectedServiceRefs.flatMap(service => {
    const serviceId = readBuiltInLegacyConnectedServiceIdForQualifiedService(service);
    return serviceId ? [serviceId] : [];
  }));
  if (serviceIds?.size === 0) return;
  if (serviceIds) {
    for (const serviceId of serviceIds) {
      connectedServiceProjectionRevisions.set(serviceId, (connectedServiceProjectionRevisions.get(serviceId) ?? 0) + 1);
    }
  } else activeConnectedServicesProjectionRevision += 1;
  for (const listener of connectedServiceProjectionListeners) {
    try { listener(serviceIds); } catch { /* One consumer cannot prevent projection invalidation. */ }
  }
}

/** Configured-source currentness includes its own projection, separate from Settings. */
export function subscribeActiveAccountConfiguredExternalSessionSourceRevision(
  listener: (revision: string) => void,
  sources: readonly ExternalSessionSourceDeclarationInput[] = [],
  activeServerId: string | null = null,
): () => void {
  const services = configuredExternalSessionSourceServiceIds(sources);
  const notify = () => listener(resolveActiveAccountConfiguredExternalSessionSourceRevision(active, sources, activeServerId));
  const onProjection = (serviceIds?: ReadonlySet<string>) => {
    if (services.size > 0 && (serviceIds === undefined || Array.from(serviceIds).some(serviceId => services.has(serviceId)))) notify();
  };
  const unsubscribe = subscribeActiveAccountSettingsKeys({ settings: configuredExternalSessionSourceSettingsKeys(sources) }, (previous, next) => {
    if (previous === next) return;
    if (!previous || !next || !belongsToSameAccount(previous, next)
      || resolveActiveAccountConfiguredExternalSessionSourceRevision(previous, sources, activeServerId)
        !== resolveActiveAccountConfiguredExternalSessionSourceRevision(next, sources, activeServerId)) notify();
  });
  connectedServiceProjectionListeners.add(onProjection);
  return () => { unsubscribe(); connectedServiceProjectionListeners.delete(onProjection); };
}

export function resetActiveAccountSettingsSnapshotForTests(): void {
  const previous = active;
  zeroRetiredSavedSecretResourceDataKeys(previous?.savedSecretResources, undefined);
  active = null;
  published = null;
  if (previous) activeLifetimeToken += 1;
  activeConnectedServicesProjectionRevision = 0;
  connectedServiceProjectionRevisions.clear();
}

export function subscribeActiveAccountSettingsSnapshot(listener: ActiveAccountSettingsSnapshotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribes to publications that change the snapshot itself: Settings, the
 * Saved Secret catalog, or the Account lifetime. Connected Services projection
 * notices use the configured-source revision subscription independently.
 */
export function subscribeActiveAccountSettingsSnapshotChanges(
  listener: ActiveAccountSettingsSnapshotListener,
): () => void {
  return subscribeActiveAccountSettingsSnapshot((previous, next) => {
    if (previous === next) return;
    listener(previous, next);
  });
}

export type ActiveAccountSettingsKeys = Readonly<{
  settings?: readonly string[];
  rawSettings?: readonly string[];
  facets?: readonly typeof independentAccountFields[number][];
}>;

/** Observe consumed preferences and catalog facets at the Account publication cut. */
export function subscribeActiveAccountSettingsKeys(
  keys: ActiveAccountSettingsKeys | (() => ActiveAccountSettingsKeys),
  listener: ActiveAccountSettingsSnapshotListener,
): () => void {
  let lifetime = activeLifetimeToken;
  return subscribeActiveAccountSettingsSnapshot((previous, next) => {
    const lifetimeChanged = lifetime !== activeLifetimeToken;
    lifetime = activeLifetimeToken;
    const selected = typeof keys === 'function' ? keys() : keys;
    if (lifetimeChanged || previous?.scopeKey !== next?.scopeKey
      || previous?.source !== next?.source
      || previous?.settingsSecretsReadKeys !== next?.settingsSecretsReadKeys
      || (selected.settings ?? []).some(key => !Object.is(previous?.settings[key], next?.settings[key]))
      || (selected.rawSettings ?? []).some(key => !Object.is(previous?.rawSettings?.[key], next?.rawSettings?.[key]))
      || (selected.facets ?? []).some(facet => previous?.[facet] !== next?.[facet])) {
      listener(previous, next);
    }
  });
}
