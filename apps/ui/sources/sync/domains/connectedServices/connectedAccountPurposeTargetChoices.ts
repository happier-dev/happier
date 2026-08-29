import type {
  PluginConnectedAccountAuthenticationV2,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import { t } from '@/text';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';

import {
  resolveConnectedAccountPurposeTargetEligibility,
  type ConnectedAccountPurposeTargetEligibility,
} from './connectedAccountPurposeTargetEligibility';
import { getQualifiedConnectedServiceRegistryEntry } from './connectedServiceRegistry';
import {
  presentQualifiedConnectedAccountTarget,
  type QualifiedConnectedAccountTargetPresentation,
} from './qualifiedConnectedAccountTargetPresentation';

function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameTarget(
  left: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
  right: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'account' && right.kind === 'account') {
    return sameService(left.account.service, right.account.service)
      && left.account.accountId === right.account.accountId;
  }
  if (left.kind === 'group' && right.kind === 'group') {
    return sameService(left.service, right.service) && left.groupId === right.groupId;
  }
  return false;
}

export function connectedAccountPurposeTargetChoiceId(
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
): string {
  if (!target) return 'none';
  return target.kind === 'account'
    ? JSON.stringify([
        'account',
        target.account.service.pluginId,
        target.account.service.localId,
        target.account.accountId,
      ])
    : JSON.stringify([
        'group',
        target.service.pluginId,
        target.service.localId,
        target.groupId,
      ]);
}

export type ConnectedAccountPurposeTargetChoice = Readonly<{
  id: string;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  presentation: QualifiedConnectedAccountTargetPresentation;
  /** A semantic value, never a serialized target or contribution identity. */
  kind: 'none' | 'account' | 'group' | 'unavailable' | 'hydrating' | 'legacy';
  eligibility: ConnectedAccountPurposeTargetEligibility | 'none';
  selectable: boolean;
  current: boolean;
}>;

/**
 * The canonical choice projection for Connected Account consumer purposes.
 * It owns current/deleted/incompatible semantics; Provider only owns CAS and
 * stores the target it receives from this projection.
 */
export function buildConnectedAccountPurposeTargetChoices(input: Readonly<{
  declaration: Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    required: boolean;
  }>;
  selectedTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  /** The incumbent Connected Accounts user-label preference projection. */
  labelsByKey: Readonly<Record<string, string | undefined>>;
  /** Applied descriptor title for the declaration service, never an installed-manifest guess. */
  serviceTitle: string;
  sourceNegotiation?: ConnectedAccountUiNegotiation;
  resolveAuthentication: (
    service: PluginContributionIdentityV1,
  ) => PluginConnectedAccountAuthenticationV2 | null;
}>): readonly ConnectedAccountPurposeTargetChoice[] {
  const candidates: ConnectedAccountPurposeTargetChoice[] = [];
  if (!input.declaration.required) {
    candidates.push({
      id: connectedAccountPurposeTargetChoiceId(null),
      target: null,
      presentation: {
        primaryLabel: t('common.none'),
        accessibilityLabel: t('common.none'),
      },
      kind: 'none',
      eligibility: 'none',
      selectable: true,
      current: input.selectedTarget === null,
    });
  }

  const declaredServices = [input.declaration.service];
  const accountCandidates = input.accounts
    .filter((candidate) => sameService(candidate.ref.service, input.declaration.service))
    .map((account) => {
    const target: QualifiedConnectedAccountPurposeBindingTargetV1 = {
      kind: 'account',
      account: account.ref,
    };
    const eligibility = resolveConnectedAccountPurposeTargetEligibility({
      target,
      declaredServices,
      accounts: input.accounts,
      groups: input.groups,
      resolveAuthentication: input.resolveAuthentication,
    });
    return {
      id: connectedAccountPurposeTargetChoiceId(target),
      target,
      presentation: presentQualifiedConnectedAccountTarget({
        target,
        accounts: input.accounts,
        groups: input.groups,
        labelsByKey: input.labelsByKey,
        legacyServiceId: getQualifiedConnectedServiceRegistryEntry(account.ref.service)?.legacyServiceId ?? null,
        serviceTitle: input.serviceTitle,
      }),
      kind: 'account',
      eligibility,
      selectable: eligibility === 'usable',
      current: sameTarget(target, input.selectedTarget),
    } satisfies ConnectedAccountPurposeTargetChoice;
  })
    .sort((left, right) => left.presentation.primaryLabel.localeCompare(right.presentation.primaryLabel));
  candidates.push(...accountCandidates);

  const groupCandidates = input.groups
    .filter((candidate) => sameService(candidate.ref.service, input.declaration.service))
    .map((group) => {
    const target: QualifiedConnectedAccountPurposeBindingTargetV1 = {
      kind: 'group',
      service: group.ref.service,
      groupId: group.ref.groupId,
    };
    const eligibility = resolveConnectedAccountPurposeTargetEligibility({
      target,
      declaredServices,
      accounts: input.accounts,
      groups: input.groups,
      resolveAuthentication: input.resolveAuthentication,
    });
    return {
      id: connectedAccountPurposeTargetChoiceId(target),
      target,
      presentation: presentQualifiedConnectedAccountTarget({
        target,
        accounts: input.accounts,
        groups: input.groups,
        labelsByKey: input.labelsByKey,
        legacyServiceId: getQualifiedConnectedServiceRegistryEntry(group.ref.service)?.legacyServiceId ?? null,
        serviceTitle: input.serviceTitle,
      }),
      kind: 'group',
      eligibility,
      selectable: eligibility === 'usable',
      current: sameTarget(target, input.selectedTarget),
    } satisfies ConnectedAccountPurposeTargetChoice;
  })
    .sort((left, right) => left.presentation.primaryLabel.localeCompare(right.presentation.primaryLabel));
  candidates.push(...groupCandidates);

  if (input.selectedTarget && !candidates.some((candidate) => candidate.current)) {
    const presentation = presentQualifiedConnectedAccountTarget({
      target: input.selectedTarget,
      accounts: input.accounts,
      groups: input.groups,
      labelsByKey: input.labelsByKey,
      serviceTitle: input.serviceTitle,
      sourceNegotiation: input.sourceNegotiation,
    });
    candidates.push({
      id: connectedAccountPurposeTargetChoiceId(input.selectedTarget),
      target: input.selectedTarget,
      presentation,
      kind: input.sourceNegotiation === 'indeterminate'
        ? 'hydrating'
        : input.sourceNegotiation === 'legacy'
          ? 'legacy'
          : 'unavailable',
      eligibility: 'unusable',
      selectable: false,
      current: true,
    });
  }
  return candidates;
}

/** Render a current target without exposing its serialized/raw identity. */
export function resolveConnectedAccountPurposeTargetDisplay(input: Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  labelsByKey: Readonly<Record<string, string | undefined>>;
  serviceTitle: string;
  sourceNegotiation?: ConnectedAccountUiNegotiation;
}>): string {
  return presentQualifiedConnectedAccountTarget({
    target: input.target,
    accounts: input.accounts,
    groups: input.groups,
    labelsByKey: input.labelsByKey,
    legacyServiceId: getQualifiedConnectedServiceRegistryEntry(
      input.target.kind === 'account' ? input.target.account.service : input.target.service,
    )?.legacyServiceId ?? null,
    serviceTitle: input.serviceTitle,
    sourceNegotiation: input.sourceNegotiation,
  }).primaryLabel;
}
