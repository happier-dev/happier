import type {
  ConnectedServiceId,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  QualifiedConnectedAccountRef,
  TeamResourceConnectedServiceSelectionV2,
} from '@happier-dev/protocol';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import type { ConnectedAccountIdentityLabelKind, ConnectedAccountIdentityPresenter } from './maskAccountEmail';
import { abbreviateConnectedAccountId } from './maskAccountEmail';

import {
  resolveQualifiedConnectedAccountLabel,
} from './connectedServiceProfilePreferences';

/** The non-secret account facts a qualified-target surface may present. */
export type QualifiedConnectedAccountPresentationAccount = Readonly<{
  ref: QualifiedConnectedAccountRef;
  displayName?: string | null;
  providerIdentity?: Readonly<{
    email?: string | null;
    accountId?: string | null;
  }> | null;
}>;

/** The non-secret group facts a qualified-target surface may present. */
export type QualifiedConnectedAccountPresentationGroup = Readonly<{
  ref: Readonly<{
    service: PluginContributionIdentityV1;
    groupId: string;
  }>;
  displayName?: string | null;
}>;

export type QualifiedConnectedAccountTargetPresentation = Readonly<{
  /** The human-facing name; never a canonical account or pool id. */
  primaryLabel: string;
  /** Identity fallback provenance for privacy; absent for names and service/state labels. */
  primaryLabelKind?: ConnectedAccountIdentityLabelKind;
  /** Account identity beside its name, without repeating the service or primary label. */
  identityLabel?: string;
  /** Supplemental, non-secret facts that distinguish targets with the same name. */
  secondaryLabel?: string;
  /**
   * De-duplicated target identity for assistive technology. It carries the same
   * recognisable facts a sighted user reads, never a canonical id: an assistive
   * reader must not be the only surface that speaks an opaque internal handle.
   */
  accessibilityLabel: string;
}>;

function nonEmptyText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function uniqueNonEmpty(parts: ReadonlyArray<string | null>): string[] {
  const unique: string[] = [];
  for (const part of parts) {
    if (!part || unique.includes(part)) continue;
    unique.push(part);
  }
  return unique;
}

function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function createPresentation(input: Readonly<{
  serviceTitle: string;
  primaryLabel: string;
  primaryLabelKind?: ConnectedAccountIdentityLabelKind;
  identityLabel?: string | null;
  secondaryParts: ReadonlyArray<string | null>;
}>): QualifiedConnectedAccountTargetPresentation {
  const secondaryParts = uniqueNonEmpty(input.secondaryParts)
    .filter((part) => part !== input.primaryLabel);
  const accessibilityParts = uniqueNonEmpty([
    input.serviceTitle,
    input.primaryLabel,
    ...secondaryParts,
  ]);
  const secondaryLabel = secondaryParts.join(' · ');
  return {
    primaryLabel: input.primaryLabel,
    ...(input.primaryLabelKind ? { primaryLabelKind: input.primaryLabelKind } : {}),
    ...(input.identityLabel ? { identityLabel: input.identityLabel } : {}),
    ...(secondaryLabel ? { secondaryLabel } : {}),
    accessibilityLabel: accessibilityParts.join(' · '),
  };
}

export type ConnectedAccountNamePresentation = Readonly<{
  /** The name people read: the user's label, the provider display name or email, else "<Service> account". */
  primaryLabel: string;
  primaryLabelKind?: ConnectedAccountIdentityLabelKind;
  /** The account has neither a name nor an email: `primaryLabel` already names its service. */
  serviceFallback: boolean;
  /** Identity beside the name: its email when that is not the name, else a short provider id hint. */
  identityLabel: string | null;
  /** The email as the privacy policy shows it. */
  email: string | null;
}>;

/**
 * The one connected-account naming rule. The canonical `accountId` is routing identity and is never
 * presented: a stored display name that is that id (or the provider id, or the service title, as earlier
 * producers wrote) reads as no name, and an account with neither name nor email reads as its service's
 * account. A provider id is only a short secondary hint.
 */
export function presentConnectedAccountName(input: Readonly<{
  serviceTitle: string;
  userLabel?: string | null;
  displayName?: string | null;
  email?: string | null;
  providerAccountId?: string | null;
  accountId?: string | null;
  presentIdentity?: ConnectedAccountIdentityPresenter;
}>): ConnectedAccountNamePresentation {
  const serviceTitle = input.serviceTitle;
  const userLabel = nonEmptyText(input.userLabel);
  const email = nonEmptyText(input.email);
  const providerAccountId = nonEmptyText(input.providerAccountId);
  const storedDisplayName = nonEmptyText(input.displayName);
  // Earlier producers used the provider id as displayName. Read those stored
  // facts without requiring an Account write or a reconnect to fix the title.
  const displayName = storedDisplayName === providerAccountId || storedDisplayName === nonEmptyText(input.accountId) || storedDisplayName === serviceTitle
    ? null : storedDisplayName;
  const fallbackLabel = t('connectedServicesCollection.accountLabel', { service: serviceTitle });
  const primaryLabel = userLabel ?? displayName ?? email ?? fallbackLabel;
  const primaryLabelKind = !userLabel && !displayName && email ? 'email' : undefined;
  const shown = input.presentIdentity?.({ label: primaryLabel, labelKind: primaryLabelKind, email, accountId: providerAccountId })
    ?? { label: primaryLabel, email, accountId: providerAccountId };
  const shownPrimaryLabel = shown.label ?? fallbackLabel;
  const identityLabel = shown.email && shown.email !== shownPrimaryLabel
    ? shown.email
    : !email && !displayName && !userLabel ? abbreviateConnectedAccountId(shown.accountId) : null;
  return {
    primaryLabel: shownPrimaryLabel,
    ...(primaryLabelKind ? { primaryLabelKind } : {}),
    serviceFallback: primaryLabel === fallbackLabel,
    identityLabel,
    email: shown.email,
  };
}

export type ConnectedAccountNameEntry = Parameters<typeof presentConnectedAccountName>[0] & Readonly<{
  /** The account's stable list key (service and account), used only to order same-named accounts. */
  key: string;
}>;

/**
 * The naming rule over a list shown together: accounts of one service that would all read as that
 * service's account are told apart by number ("Claude account", "Claude account 2"). The number follows
 * the stable key order, so it does not move when the list reorders (by usage left, say); creation time
 * is not in the client projection. Never an id.
 */
export function presentConnectedAccountNames(entries: readonly ConnectedAccountNameEntry[]): ReadonlyMap<string, ConnectedAccountNamePresentation> {
  const names = new Map<string, ConnectedAccountNamePresentation>();
  const fallbacksByService = new Map<string, string[]>();
  for (const entry of entries) {
    if (names.has(entry.key)) continue;
    const name = presentConnectedAccountName(entry);
    names.set(entry.key, name);
    if (!name.serviceFallback) continue;
    const keys = fallbacksByService.get(entry.serviceTitle) ?? [];
    keys.push(entry.key);
    fallbacksByService.set(entry.serviceTitle, keys);
  }
  for (const [service, keys] of fallbacksByService) {
    if (keys.length < 2) continue;
    [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).forEach((key, index) => {
      if (index === 0) return;
      const name = names.get(key)!;
      names.set(key, { ...name, primaryLabel: t('connectedServicesCollection.accountLabelNumbered', { service, number: index + 1 }) });
    });
  }
  return names;
}

/**
 * Present a target owned by Qualified Connected Accounts. The caller supplies
 * the daemon-projected author title for its service; this owner only combines
 * that title with user labels and non-secret account/group identities.
 *
 * The canonical `accountId`/`groupId` are deliberately absent from every field
 * this returns. They are routing and mutation identity — list keys, test ids,
 * navigation params and request payloads — and a user cannot recognise a target
 * by one, so presenting one is noise on a visible row and an opaque handle in a
 * screen reader. Distinguishing facts come from the provider side instead: the
 * user label, then the provider display name and email, then the service's
 * account label. A provider id is only a short secondary hint.
 */
export function presentQualifiedConnectedAccountTarget(input: Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  accounts: readonly QualifiedConnectedAccountPresentationAccount[];
  groups: readonly QualifiedConnectedAccountPresentationGroup[];
  labelsByKey: Readonly<Record<string, string | undefined>>;
  /** A user label already resolved by the owning screen's current preferences projection. */
  accountLabel?: string | null;
  legacyServiceId?: ConnectedServiceId | null;
  serviceTitle: string | null | undefined;
  /** Negotiated source state used only when the exact structured target is absent. */
  sourceNegotiation?: ConnectedAccountUiNegotiation;
  /** The consuming device's identity privacy policy, applied before visible and assistive text. */
  presentIdentity?: ConnectedAccountIdentityPresenter;
}>): QualifiedConnectedAccountTargetPresentation {
  const serviceTitle = nonEmptyText(input.serviceTitle)
    ?? t('connectedServices.fallbackName');
  const missingTargetLabel = input.sourceNegotiation === 'indeterminate'
    ? t('common.loading')
    : input.sourceNegotiation === 'legacy'
      ? t('connectedServices.purposeTargets.legacyUnavailable')
      : t('common.unavailable');
  const target = input.target;
  if (target.kind === 'account') {
    const accountRef = target.account;
    const account = input.accounts.find((candidate) => (
      sameService(candidate.ref.service, accountRef.service)
      && candidate.ref.accountId === accountRef.accountId
    ));
    if (!account) {
      return createPresentation({
        serviceTitle,
        primaryLabel: missingTargetLabel,
        secondaryParts: [],
      });
    }
    const userLabel = nonEmptyText(input.accountLabel)
      ?? resolveQualifiedConnectedAccountLabel({
        labelsByKey: input.labelsByKey,
        service: account.ref.service,
        legacyServiceId: input.legacyServiceId ?? null,
        accountId: account.ref.accountId,
      });
    const name = presentConnectedAccountName({
      serviceTitle,
      userLabel,
      displayName: account.displayName ?? null,
      email: account.providerIdentity?.email ?? null,
      providerAccountId: account.providerIdentity?.accountId ?? null,
      accountId: account.ref.accountId,
      presentIdentity: input.presentIdentity,
    });
    return createPresentation({
      serviceTitle,
      primaryLabel: name.primaryLabel,
      primaryLabelKind: name.primaryLabelKind,
      identityLabel: name.identityLabel,
      secondaryParts: [
        name.serviceFallback ? null : serviceTitle,
        name.email,
        name.identityLabel,
      ],
    });
  }

  const groupTarget = target;
  const group = input.groups.find((candidate) => (
    sameService(candidate.ref.service, groupTarget.service)
    && candidate.ref.groupId === groupTarget.groupId
  ));
  if (!group) {
    return createPresentation({
      serviceTitle,
      primaryLabel: missingTargetLabel,
      secondaryParts: [],
    });
  }
  const displayName = nonEmptyText(group.displayName);
  const primaryLabel = displayName ?? serviceTitle;
  return createPresentation({
    serviceTitle,
    primaryLabel,
    secondaryParts: [
      primaryLabel === serviceTitle ? null : serviceTitle,
    ],
  });
}

/**
 * Present a Team resource purpose default (lane 10 child 09 §10.4): the
 * resource name, its Team and delivery mode, all from the viewer's entitled
 * Team catalog. A resource the catalog no longer offers presents as
 * unavailable; no source Account or Pool fact is ever shown.
 */
export function presentConnectedAccountPurposeTeamResource(input: Readonly<{
  teamResource: Readonly<{ teamId: string; selection: TeamResourceConnectedServiceSelectionV2 }>;
  teamResources: readonly TeamCredentialResourceCatalogEntryV1[];
  teamNameById?: Readonly<Record<string, string>>;
  serviceTitle: string | null | undefined;
}>): QualifiedConnectedAccountTargetPresentation {
  const serviceTitle = nonEmptyText(input.serviceTitle)
    ?? t('connectedServices.fallbackName');
  const resource = input.teamResources.find((candidate) => (
    candidate.id === input.teamResource.selection.resourceId && candidate.teamId === input.teamResource.teamId
  ));
  if (!resource) {
    return createPresentation({
      serviceTitle,
      primaryLabel: t('common.unavailable'),
      secondaryParts: [],
    });
  }
  return createPresentation({
    serviceTitle,
    primaryLabel: nonEmptyText(resource.displayName) ?? serviceTitle,
    secondaryParts: [
      nonEmptyText(input.teamNameById?.[resource.teamId]),
      t(input.teamResource.selection.deliveryMode === 'brokered'
        ? 'teams.credentials.delivery.brokered'
        : 'teams.credentials.delivery.direct'),
      serviceTitle,
    ],
  });
}
