import type {
  ConnectedServiceId,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { t } from '@/text';

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
  /** The human-facing name; never an opaque target id when a service title exists. */
  primaryLabel: string;
  /** Supplemental, non-secret facts that distinguish targets with the same name. */
  secondaryLabel?: string;
  /** Complete, de-duplicated target identity for assistive technology. */
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
    ...(secondaryLabel ? { secondaryLabel } : {}),
    accessibilityLabel: accessibilityParts.join(' · '),
  };
}

/**
 * Present a target owned by Qualified Connected Accounts. The caller supplies
 * the daemon-projected author title for its service; this owner only combines
 * that title with user labels and non-secret account/group identities.
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
}>): QualifiedConnectedAccountTargetPresentation {
  const serviceTitle = nonEmptyText(input.serviceTitle)
    ?? t('connectedServices.fallbackName');
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
        primaryLabel: t('common.unavailable'),
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
    const email = nonEmptyText(account.providerIdentity?.email);
    const providerAccountId = nonEmptyText(account.providerIdentity?.accountId);
    const displayName = nonEmptyText(account.displayName);
    const primaryLabel = userLabel ?? email ?? displayName ?? serviceTitle;
    return createPresentation({
      serviceTitle,
      primaryLabel,
      secondaryParts: [
        primaryLabel === serviceTitle ? null : serviceTitle,
        email,
        providerAccountId,
        account.ref.accountId,
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
      primaryLabel: t('common.unavailable'),
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
      group.ref.groupId,
    ],
  });
}
