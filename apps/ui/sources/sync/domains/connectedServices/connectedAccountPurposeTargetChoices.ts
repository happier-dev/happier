import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import type {
  PluginConnectedAccountAuthenticationV2} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type {
  PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type {
  QualifiedConnectedAccountPurposeBindingTargetV1} from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type {
  AgentConnectedAccountPurposeTeamResourceDefault,
} from '@happier-dev/protocol/account/settings/connected-services';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import type { ConnectedAccountUiNegotiation } from './resolveConnectedAccountUiNegotiation';
import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';

import {
  describeConnectedAccountPurposeTargetEligibility,
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

function withEligibilityReason(presentation: QualifiedConnectedAccountTargetPresentation,
  result: ReturnType<typeof describeConnectedAccountPurposeTargetEligibility>,
  descriptorsLoading: boolean): QualifiedConnectedAccountTargetPresentation {
  if (result.reason === null) return presentation;
  // A descriptor read still in flight is not a failed check; it says Loading until it settles.
  const reason = result.reason === 'serviceLookupFailed' && descriptorsLoading
    ? t('common.loading')
    : t(`connectedServices.purposeTargets.${result.reason}`);
  return { ...presentation,
    unavailableReason: reason,
    unavailableReasonCode: result.reason,
    secondaryLabel: [presentation.secondaryLabel, reason].filter(Boolean).join(' · '),
    accessibilityLabel: `${presentation.accessibilityLabel} · ${reason}` };
}

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

/**
 * The accounts and groups of one service: everything a person can choose for a purpose that draws on
 * it. Empty for a brand-new account, when there is nothing to choose.
 */
export function connectedAccountPurposeServiceTargets(
  accounts: readonly QualifiedConnectedAccountProfileV4[],
  groups: readonly QualifiedConnectedAccountGroupV4[],
  service: PluginContributionIdentityV1,
): Readonly<{ accounts: readonly QualifiedConnectedAccountProfileV4[]; groups: readonly QualifiedConnectedAccountGroupV4[] }> {
  return {
    accounts: accounts.filter((candidate) => sameService(candidate.ref.service, service)),
    groups: groups.filter((candidate) => sameService(candidate.ref.service, service)),
  };
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
export type ConnectedAccountPurposeTargetChoicesInput = Readonly<{
  declaration: Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    required: boolean;
  }>;
  selectedTarget: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  /** The purpose's current Team resource default, when that is its selection. */
  selectedTeamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
  /**
   * What an optional purpose with no target means where it is chosen (an Agent's own sign-in, an
   * unused gateway slot). Defaults to "Not set".
   */
  noneLabel?: string;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  /** The incumbent Connected Accounts user-label preference projection. */
  labelsByKey: Readonly<Record<string, string | undefined>>;
  /** Applied descriptor title for the declaration service, never an installed-manifest guess. */
  serviceTitle: string;
  sourceNegotiation?: ConnectedAccountUiNegotiation;
  /** The descriptor registry is still answering: an unreadable descriptor reads Loading, not failed. */
  descriptorsLoading?: boolean;
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
  teamResourceStatusByKey?: TeamCredentialResourceStatusByKey;
  teamNameById?: Readonly<Record<string, string>>;
}>;

export function buildConnectedAccountPurposeTargetChoices(input: ConnectedAccountPurposeTargetChoicesInput): readonly ConnectedAccountPurposeTargetChoice[] {
  const declaredTargets = connectedAccountPurposeServiceTargets(input.accounts, input.groups, input.declaration.service);
  const candidates: ConnectedAccountPurposeTargetChoice[] = [];
  const add = (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
    teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null = null) => {
    const choice = resolvePurposeTargetChoice(input, target, teamResource);
    if (choice) candidates.push(choice);
  };
  add(null);
  const accounts = declaredTargets.accounts.map(account => resolvePurposeTargetChoice(input,
    { kind: 'account', account: account.ref }, null)!);
  const groups = declaredTargets.groups.map(group => resolvePurposeTargetChoice(input,
    { kind: 'group', service: group.ref.service, groupId: group.ref.groupId }, null)!);
  const teams = (input.teamResources ?? []).filter(resource => (
    resource.sourcePresentation?.kind === 'connected_service'
    && sameService(resource.sourcePresentation.service, input.declaration.service)
  )).flatMap(resource => resource.connectedServiceSelections.flatMap(selection => {
    if (selection.deliveryMode === 'direct' && !sameService(selection.disclosedMember.service, input.declaration.service)) return [];
    return [resolvePurposeTargetChoice(input, null, { teamId: resource.teamId, selection })!];
  }));
  for (const choices of [accounts, groups, teams]) {
    candidates.push(...choices.sort((left, right) => left.presentation.primaryLabel.localeCompare(right.presentation.primaryLabel)));
  }
  if ((input.selectedTarget || input.selectedTeamResource) && !candidates.some(candidate => candidate.current)) {
    const selected = resolveSelectedConnectedAccountPurposeTargetChoice(input);
    if (selected) candidates.push(selected);
  }
  return candidates;
}

/** The same exact-target projection serves the closed summary and each open choice. */
export function resolveSelectedConnectedAccountPurposeTargetChoice(input: ConnectedAccountPurposeTargetChoicesInput): ConnectedAccountPurposeTargetChoice | null {
  return resolvePurposeTargetChoice(input, input.selectedTarget, input.selectedTeamResource ?? null);
}

function resolvePurposeTargetChoice(input: ConnectedAccountPurposeTargetChoicesInput,
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
  teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null): ConnectedAccountPurposeTargetChoice | null {
  const current = teamResource ? sameTeamResource(teamResource, input.selectedTeamResource ?? null)
    : !input.selectedTeamResource && sameTarget(target, input.selectedTarget);
  if (teamResource) {
    const resource = (input.teamResources ?? []).find(resource => resource.id === teamResource.selection.resourceId && resource.teamId === teamResource.teamId);
    const offered = resource?.sourcePresentation?.kind === 'connected_service'
      && sameService(resource.sourcePresentation.service, input.declaration.service)
      && resource.connectedServiceSelections.some(selection => areTeamResourceConnectedServiceSelectionsEqual(selection, teamResource.selection))
      && (teamResource.selection.deliveryMode !== 'direct' || sameService(teamResource.selection.disclosedMember.service, input.declaration.service));
    const resourceCurrent = offered && (input.teamResourceStatusByKey === undefined
      || input.teamResourceStatusByKey.get(`${teamResource.teamId}:${resource!.id}`)?.kind === 'current');
    const eligibility = resourceCurrent ? resolveConnectedAccountPurposeTeamResourceEligibility({
      teamResource, service: input.declaration.service, teamResources: input.teamResources ?? [],
    }) : 'unusable';
    return {
      id: connectedAccountPurposeTargetChoiceId(null, teamResource), target: null, teamResource,
      presentation: presentConnectedAccountPurposeTeamResource({ teamResource, teamResources: input.teamResources ?? [],
        serviceTitle: input.serviceTitle, ...(input.teamNameById ? { teamNameById: input.teamNameById } : {}) }),
      kind: resourceCurrent ? 'team_resource' : 'unavailable', eligibility,
      selectable: Boolean(resourceCurrent) && eligibility === 'usable', current,
    };
  }
  if (!target) {
    if (input.declaration.required) return null;
    const label = input.noneLabel ?? t('connectedServices.purposeTargets.notSet');
    return { id: connectedAccountPurposeTargetChoiceId(null), target: null, teamResource: null,
      presentation: { primaryLabel: label, accessibilityLabel: label }, kind: 'none', eligibility: 'none', selectable: true, current };
  }
  const service = target.kind === 'account' ? target.account.service : target.service;
  const exists = sameService(service, input.declaration.service) && (target.kind === 'account'
    ? input.accounts.some(account => sameTarget({ kind: 'account', account: account.ref }, target))
    : input.groups.some(group => sameTarget({ kind: 'group', service: group.ref.service, groupId: group.ref.groupId }, target)));
  const presentation = presentQualifiedConnectedAccountTarget({ target, accounts: input.accounts, groups: input.groups,
    labelsByKey: input.labelsByKey, serviceTitle: input.serviceTitle, sourceNegotiation: exists ? undefined : input.sourceNegotiation,
    presentIdentity: input.presentIdentity });
  const unresolved = !exists && (input.sourceNegotiation === 'indeterminate' || input.sourceNegotiation === 'legacy');
  const result = describeConnectedAccountPurposeTargetEligibility({ target, declaredServices: [input.declaration.service],
    accounts: input.accounts, groups: input.groups, resolveAuthentication: input.resolveAuthentication });
  return {
    id: connectedAccountPurposeTargetChoiceId(target), target, teamResource: null,
    presentation: unresolved ? presentation : withEligibilityReason(presentation, result, input.descriptorsLoading === true),
    kind: exists ? target.kind : input.sourceNegotiation === 'indeterminate' ? 'hydrating'
      : input.sourceNegotiation === 'legacy' ? 'legacy' : 'unavailable',
    eligibility: exists ? result.eligibility : 'unusable', selectable: exists && result.eligibility === 'usable', current,
  };
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
