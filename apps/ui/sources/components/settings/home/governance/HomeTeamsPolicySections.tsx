import * as React from 'react';
import { type TeamCreationPolicyV1 } from '@happier-dev/protocol/home/governance';

import {
  SettingAnchor,
  SettingRow,
} from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import {
  setHomeTeamCreationPolicy,
  setHomeTeamsVisibleToMembers,
  type HomeGovernanceAcknowledgedOutcome,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import type { HomeAdministrationContext } from './homeAdministrationContext';
import {
  homeGovernanceFailureNotice,
  teamCreationPolicyDescription,
} from './homeGovernanceLabels';
import { HOME_TEAMS_POLICY_SETTINGS } from './homeTeamsPolicySettings';

/**
 * The Home's Team policies, on the Teams page where an owner looks for them (DR-09, lab
 * `hcTeams-A`): who creates Teams, and whether members outside every Team see them. Both write the
 * Home's one revision-guarded policy document.
 */

const TEAM_CREATION_CHOICES: readonly TeamCreationPolicyV1[] = [
  'self_service',
  'managed_only',
  'disabled',
];

/**
 * One field of the Home's single revision-guarded policy document, edited in place.
 *
 * The selection is never shown as applied before the Home confirms it. On a
 * revision conflict the administrator's choice is deliberately kept on screen:
 * they still want it, they simply need to see what changed underneath and apply
 * it again.
 */
function useHomePolicyFieldEditor<TValue>(
  input: Readonly<{
    context: HomeAdministrationContext;
    committed: TValue;
    save: (
      params: Readonly<{ expectedRevision: number; value: TValue }>,
    ) => Promise<HomeGovernanceAcknowledgedOutcome>;
  }>,
) {
  const { context, committed, save } = input;
  const { projection, scope } = context;

  const [pending, setPending] = React.useState<TValue | null>(null);
  // The Home's own refusal, kept so the retry row can say what actually
  // happened instead of one sentence that also has to cover a lost answer.
  const [saveFailure, setSaveFailure] =
    React.useState<HomeDomainFailure | null>(null);
  const operationInFlightRef = React.useRef<symbol | null>(null);
  // A conflicted choice outlives the failed save so it can be applied again.
  const [draft, setDraft] = React.useState<TValue | null>(null);

  // The editor is reusable on its own, so it discards a draft entered for
  // another Home/Account from its own props rather than relying on the host
  // that currently mounts it.
  React.useEffect(() => {
    operationInFlightRef.current = null;
    setDraft(null);
    setPending(null);
    setSaveFailure(null);
  }, [scope.serverId, scope.accountId]);

  // Once the Home reports the value the administrator wanted, the local draft
  // has served its purpose and the projection becomes the only truth again.
  React.useEffect(() => {
    setDraft((current) =>
      current === null || current === committed ? null : current,
    );
    setSaveFailure(null);
  }, [committed]);

  const selected = draft ?? committed;

  const choose = React.useCallback(
    async (next: TValue) => {
      if (
        operationInFlightRef.current !== null ||
        (next === selected && draft === null)
      )
        return;
      const operationIdentity = Symbol('home-policy-field');
      operationInFlightRef.current = operationIdentity;
      setDraft(next);
      setSaveFailure(null);
      setPending(next);
      try {
        const outcome = await save({
          expectedRevision: projection.policy.revision,
          value: next,
        });
        if (operationInFlightRef.current !== operationIdentity) return;
        if (outcome.kind === 'succeeded') return;
        if (outcome.kind === 'approval_pending') {
          context.requestApproval?.(outcome.artifactId);
          return;
        }
        if (
          outcome.kind === 'failed' &&
          outcome.failure.code === 'home_policy_revision_conflict'
        ) {
          await Modal.alertAsync(
            t('homeGovernance.revisionConflictTitle'),
            t('homeGovernance.revisionConflictBody'),
          );
          context.refresh();
          return;
        }
        setSaveFailure(outcome.failure);
      } finally {
        if (operationInFlightRef.current === operationIdentity) {
          operationInFlightRef.current = null;
          setPending(null);
        }
      }
    },
    [selected, draft, save, projection.policy.revision, context],
  );

  // The shell owns the shared-approval artifact and releases it on execution,
  // rejection and failure. Latching it here would keep saying "waiting" after
  // a terminal decision the shell has already acted on.
  return {
    selected,
    pending,
    saveFailure,
    approvalPending: context.approvalPending,
    choose,
  };
}

/** A policy save's refusal and its retry, then any pending shared approval, under the rows. */
const HomePolicyFieldStatusRows = React.memo(function HomePolicyFieldStatusRows(
  props: Readonly<{
    testIDPrefix: string;
    saveFailure: HomeDomainFailure | null;
    approvalPending: boolean | undefined;
    retryDisabled: boolean;
    onRetry: (() => void) | undefined;
  }>,
) {
  return (
    <>
      {props.saveFailure ? (
        <SurfaceStateCard
          testID={`${props.testIDPrefix}-failed`}
          kind="error"
          size="line"
          title={homeGovernanceFailureNotice(props.saveFailure).body}
          action={
            props.onRetry
              ? {
                  testID: `${props.testIDPrefix}-retry`,
                  label: t('homeGovernance.retry'),
                  onPress: props.onRetry,
                  disabled: props.retryDisabled,
                }
              : undefined
          }
        />
      ) : null}
      {props.approvalPending ? (
        <Item
          testID={`${props.testIDPrefix}-approval-pending`}
          title={t('connect.waitingForApproval')}
          showChevron={false}
        />
      ) : null}
    </>
  );
});

/** Team creation: who may create a Team on this Home. */
export const TeamCreationPolicyEditor = React.memo(
  function TeamCreationPolicyEditor(
    props: Readonly<{ context: HomeAdministrationContext }>,
  ) {
    const { context } = props;
    const { projection, scope, mutationsAvailable } = context;
    const save = React.useCallback(
      (
        params: Readonly<{
          expectedRevision: number;
          value: TeamCreationPolicyV1;
        }>,
      ) =>
        setHomeTeamCreationPolicy({
          scope,
          expectedRevision: params.expectedRevision,
          teamCreationPolicy: params.value,
        }),
      [scope],
    );
    const editor = useHomePolicyFieldEditor({
      context,
      committed: projection.policy.teamCreationPolicy,
      save,
    });
    const editable = projection.capabilities.manageTeamCreationPolicy;
    const { selected, pending, choose } = editor;

    // Three short choices, all visible; the line under them says what the current one means (lab `hcTeams-A`).
    const shown = pending ?? selected;
    return (
      <ItemGroup
        title={t('homeGovernance.teamCreation')}
        // A Home that is not answering is said once, by the page banner, not on every section.
        description={editable ? undefined : t('homeGovernance.policyReadOnly')}
      >
        <SettingAnchor
          setting={HOME_TEAMS_POLICY_SETTINGS.settings.teamCreationPolicy}
        >
          <SegmentedChoiceItem<TeamCreationPolicyV1>
            testID="home-policy-team-creation"
            testIDPrefix="home-policy-team-creation"
            title={t('homeGovernance.teamCreationWho')}
            subtitleLines={0}
            loading={pending !== null}
            mode="info"
            options={TEAM_CREATION_CHOICES.map((choice) => ({
              id: choice,
              label: teamCreationPolicyShortLabel(choice),
              description: teamCreationPolicyDescription(choice),
            }))}
            value={shown}
            onChange={(choice) => {
              void choose(choice);
            }}
            disabled={!editable || !mutationsAvailable || pending !== null}
          />
        </SettingAnchor>
        <HomePolicyFieldStatusRows
          testIDPrefix="home-policy-team-creation"
          saveFailure={editor.saveFailure}
          approvalPending={editor.approvalPending}
          retryDisabled={!editable || !mutationsAvailable || pending !== null}
          onRetry={
            editable && mutationsAvailable && pending === null
              ? () => {
                  void choose(selected);
                }
              : undefined
          }
        />
      </ItemGroup>
    );
  },
);

function teamCreationPolicyShortLabel(policy: TeamCreationPolicyV1): string {
  switch (policy) {
    case 'self_service':
      return t('homeGovernance.teamCreationAnyone');
    case 'managed_only':
      return t('homeGovernance.teamCreationAdmins');
    case 'disabled':
      return t('homeGovernance.teamCreationNobody');
  }
}

/**
 * Whether members who are in no Team still see Teams. Members of a Team and
 * administrators always do; the Home decides, never a client.
 */
export const TeamsVisibilityPolicyEditor = React.memo(
  function TeamsVisibilityPolicyEditor(
    props: Readonly<{ context: HomeAdministrationContext }>,
  ) {
    const { context } = props;
    const { projection, scope, mutationsAvailable } = context;
    const save = React.useCallback(
      (params: Readonly<{ expectedRevision: number; value: boolean }>) =>
        setHomeTeamsVisibleToMembers({
          scope,
          expectedRevision: params.expectedRevision,
          teamsVisibleToMembers: params.value,
        }),
      [scope],
    );
    // A Home that predates the policy reports nothing: it shows Teams to everyone and cannot store
    // this choice, so the row is not offered there.
    const reported = projection.policy.teamsVisibleToMembers;
    const editor = useHomePolicyFieldEditor({
      context,
      committed: reported ?? true,
      save,
    });
    const editable = projection.capabilities.manageTeamCreationPolicy;
    const { selected, pending, choose } = editor;
    const interactive = editable && mutationsAvailable && pending === null;
    if (reported === undefined) return null;

    return (
      <ItemGroup
        title={t('homeGovernance.teamsVisibility')}
        // A Home that is not answering is said once, by the page banner, not on every section.
        description={editable ? undefined : t('homeGovernance.policyReadOnly')}
      >
        <SettingRow
          setting={HOME_TEAMS_POLICY_SETTINGS.settings.teamsVisibleToMembers}
          testID="home-policy-teams-visible-to-members"
          loading={pending !== null}
          disabled={!interactive}
          onPress={
            interactive
              ? () => {
                  void choose(!selected);
                }
              : undefined
          }
          rightElement={
            <Switch
              testID="home-policy-teams-visible-to-members-switch"
              value={selected}
              disabled={!interactive}
              onValueChange={(next) => {
                void choose(next);
              }}
            />
          }
          showChevron={false}
        />
        <HomePolicyFieldStatusRows
          testIDPrefix="home-policy-teams-visible-to-members"
          saveFailure={editor.saveFailure}
          approvalPending={editor.approvalPending}
          retryDisabled={!interactive}
          onRetry={
            interactive
              ? () => {
                  void choose(selected);
                }
              : undefined
          }
        />
      </ItemGroup>
    );
  },
);
