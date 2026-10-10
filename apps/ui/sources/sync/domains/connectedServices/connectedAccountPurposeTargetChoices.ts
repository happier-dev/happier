import type {
  PluginConnectedAccountAuthenticationV2,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  AgentConnectedAccountPurposeTeamResourceDefault,
} from '@happier-dev/protocol';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';

import {
  resolveConnectedAccountPurposeTargetEligibility,
  resolveConnectedAccountPurposeTeamResourceEligibility,
  type ConnectedAccountPurposeTargetEligibility,
} from './connectedAccountPurposeTargetEligibility';
import {
  areTeamResourceConnectedServiceSelectionsEqual,
  teamResourceConnectedServiceSelectionKey,
} from './connectedServicesAgentOptionStateBindings';
import {
  presentConnectedAccountPurposeTeamResource,
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

function sameTeamResource(
  left: AgentConnectedAccountPurposeTeamResourceDefault | null,
  right: AgentConnectedAccountPurposeTeamResourceDefault | null,
): boolean {
  if (!left || !right) return left === right;
  return left.teamId === right.teamId
    && areTeamResourceConnectedServiceSelectionsEqual(left.selection, right.selection);
}

export function connectedAccountPurposeTargetChoiceId(
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
  teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null = null,
): string {
  if (teamResource) {
    return JSON.stringify([
      'team_resource',
      teamResource.teamId,
      teamResourceConnectedServiceSelectionKey(teamResource.selection),
    ]);
  }
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
  /** A personal account or group; null for "none" and for a Team resource choice. */
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  /**
   * A Team resource the viewer is entitled to, as the canonical Team selection
   * of its Team. It is never a purpose target (lane 10 child 02 :271, child 06
   * :506); the Agent default owner persists it as that selection.
   */
  teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null;
  presentation: QualifiedConnectedAccountTargetPresentation;
  /** A semantic value, never a serialized target or contribution identity. */
  kind: 'none' | 'account' | 'group' | 'team_resource' | 'unavailable' | 'hydrating' | 'legacy';
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
  /** The purpose's current Team resource default, when that is its selection. */
  selectedTeamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  /** The incumbent Connected Accounts user-label preference projection. */
  labelsByKey: Readonly<Record<string, string | undefined>>;
  /** Applied descriptor title for the declaration service, never an installed-manifest guess. */
  serviceTitle: string;
  sourceNegotiation?: ConnectedAccountUiNegotiation;
  presentIdentity?: ConnectedAccountIdentityPresenter;
  resolveAuthentication: (
    service: PluginContributionIdentityV1,
  ) => PluginConnectedAccountAuthenticationV2 | null;
  /**
   * The viewer's entitled Team catalog (lane 10 child 09 §10.4). Each exact
   * Team selection the Home offers for the declared service is one choice;
   * no source Account or Pool is copied into the recipient's choices.
   */
  teamResources?: readonly TeamCredentialResourceCatalogEntryV1[];
  /** Exact Home catalog currentness; stale retained resources stay visible but cannot be selected. */
  teamResourceCurrentKeys?: ReadonlySet<string>;
  teamNameById?: Readonly<Record<string, string>>;
}>): readonly ConnectedAccountPurposeTargetChoice[] {
  const candidates: ConnectedAccountPurposeTargetChoice[] = [];
  const selectedTeamResource = input.selectedTeamResource ?? null;
  if (!input.declaration.required) {
    candidates.push({
      id: connectedAccountPurposeTargetChoiceId(null),
      target: null,
      teamResource: null,
      presentation: {
        primaryLabel: t('common.none'),
        accessibilityLabel: t('common.none'),
      },
      kind: 'none',
      eligibility: 'none',
      selectable: true,
      current: input.selectedTarget === null && selectedTeamResource === null,
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
      teamResource: null,
      presentation: presentQualifiedConnectedAccountTarget({
        target,
        accounts: input.accounts,
        groups: input.groups,
        labelsByKey: input.labelsByKey,
        serviceTitle: input.serviceTitle,
        presentIdentity: input.presentIdentity,
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
      teamResource: null,
      presentation: presentQualifiedConnectedAccountTarget({
        target,
        accounts: input.accounts,
        groups: input.groups,
        labelsByKey: input.labelsByKey,
        serviceTitle: input.serviceTitle,
        presentIdentity: input.presentIdentity,
      }),
      kind: 'group',
      eligibility,
      selectable: eligibility === 'usable',
      current: sameTarget(target, input.selectedTarget),
    } satisfies ConnectedAccountPurposeTargetChoice;
  })
    .sort((left, right) => left.presentation.primaryLabel.localeCompare(right.presentation.primaryLabel));
  candidates.push(...groupCandidates);

  const teamCandidates = (input.teamResources ?? [])
    .filter((resource) => (
      resource.sourcePresentation?.kind === 'connected_service'
      && sameService(resource.sourcePresentation.service, input.declaration.service)
    ))
    .flatMap((resource) => resource.connectedServiceSelections.flatMap((selection) => {
      const resourceCurrent = input.teamResourceCurrentKeys === undefined
        || input.teamResourceCurrentKeys.has(`${resource.teamId}:${resource.id}`);
      if (
        selection.deliveryMode === 'direct'
        && !sameService(selection.disclosedMember.service, input.declaration.service)
      ) return [];
      const teamResource: AgentConnectedAccountPurposeTeamResourceDefault = {
        teamId: resource.teamId,
        selection,
      };
      const eligibility = resourceCurrent
        ? resolveConnectedAccountPurposeTeamResourceEligibility({
        teamResource,
        service: input.declaration.service,
        teamResources: input.teamResources ?? [],
      })
        : 'unusable' as const;
      return [{
        id: connectedAccountPurposeTargetChoiceId(null, teamResource),
        target: null,
        teamResource,
        presentation: presentConnectedAccountPurposeTeamResource({
          teamResource,
          teamResources: input.teamResources ?? [],
          serviceTitle: input.serviceTitle,
          ...(input.teamNameById ? { teamNameById: input.teamNameById } : {}),
        }),
        kind: resourceCurrent ? 'team_resource' : 'unavailable',
        eligibility,
        selectable: resourceCurrent && eligibility === 'usable',
        current: sameTeamResource(teamResource, selectedTeamResource),
      } satisfies ConnectedAccountPurposeTargetChoice];
    }))
    .sort((left, right) => left.presentation.primaryLabel.localeCompare(right.presentation.primaryLabel));
  candidates.push(...teamCandidates);

  if (selectedTeamResource && !candidates.some((candidate) => candidate.current)) {
    // A withdrawn Team default stays the visible, unavailable current choice
    // until the user replaces it; there is no personal fallback (child 02 §11.6).
    candidates.push({
      id: connectedAccountPurposeTargetChoiceId(null, selectedTeamResource),
      target: null,
      teamResource: selectedTeamResource,
      presentation: presentConnectedAccountPurposeTeamResource({
        teamResource: selectedTeamResource,
        teamResources: input.teamResources ?? [],
        serviceTitle: input.serviceTitle,
        ...(input.teamNameById ? { teamNameById: input.teamNameById } : {}),
      }),
      kind: 'unavailable',
      eligibility: 'unusable',
      selectable: false,
      current: true,
    });
  }
  if (input.selectedTarget && !candidates.some((candidate) => candidate.current)) {
    const presentation = presentQualifiedConnectedAccountTarget({
      target: input.selectedTarget,
      accounts: input.accounts,
      groups: input.groups,
      labelsByKey: input.labelsByKey,
      serviceTitle: input.serviceTitle,
      sourceNegotiation: input.sourceNegotiation,
      presentIdentity: input.presentIdentity,
    });
    candidates.push({
      id: connectedAccountPurposeTargetChoiceId(input.selectedTarget),
      target: input.selectedTarget,
      teamResource: null,
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
  presentIdentity?: ConnectedAccountIdentityPresenter;
}>): string {
  return presentQualifiedConnectedAccountTarget({
    target: input.target,
    accounts: input.accounts,
    groups: input.groups,
    labelsByKey: input.labelsByKey,
    serviceTitle: input.serviceTitle,
    sourceNegotiation: input.sourceNegotiation,
    presentIdentity: input.presentIdentity,
  }).primaryLabel;
}
