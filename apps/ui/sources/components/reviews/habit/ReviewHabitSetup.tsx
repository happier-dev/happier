import * as React from 'react';
import { View } from 'react-native';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';

import { useExecutableParticipantSections } from '@/components/discussions/useExecutableParticipantSections';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { AccountTriggerRow } from '@/components/workflows/triggers/accountTriggerRows';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import { useProviderSettings } from '@/providers/hooks/useProviderSettings';
import { resolveLaunchProfileAuthoringIntent } from '@/sync/domains/profiles/resolveLaunchProfileAuthoringIntent';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import { useAccountSettingsScope, useSetting } from '@/sync/store/hooks';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { t } from '@/text';

type Choice = 'off' | 'eachTurn';

/**
 * Who reviews each turn, chosen once when the habit is set up (ORCH ruling 2026-11-22): the shared "add an agent"
 * recipe opens pre-filled from the New Session selection — its default-Agent owner, `resolvePreferredBackendTarget`,
 * and the New Session profile intent from `resolveLaunchProfileAuthoringIntent` — and the person saves it explicitly.
 * Mounted only while that choice is open, so nothing here reads at rest.
 */
export function ReviewHabitReviewerSetup(
  props: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    /** The Session the habit is for: the reviewer starts on its Machine and folder. */
    consumerSessionId: string | null;
    onChoose: (reviewer: ReviewReviewerSelectionV1) => void;
    onCancel: () => void;
  }>,
) {
  const seedProfileId = useNewSessionProfileIntentId();
  const { onChoose, onCancel } = props;
  const choose = React.useCallback(
    (selection: ExecutableParticipantSelectionV1) => {
      if (selection.kind === 'model') onChoose(selection);
    },
    [onChoose],
  );
  const { addAgent, recipeEditor, offersAgents } = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    enabled: true,
    requireWorkspaceWriteDenial: true,
    consumerSessionId: props.consumerSessionId,
    sessionsContext: '',
    seedProfileId,
    onChoose: choose,
  });
  // The recipe opens once its Machines are known; closing it without a choice cancels the setup.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current || !addAgent) return;
    opened.current = true;
    addAgent();
  }, [addAgent]);
  const shown = React.useRef(false);
  React.useEffect(() => {
    if (recipeEditor !== null) shown.current = true;
    else if (shown.current) onCancel();
  }, [recipeEditor, onCancel]);
  // No Machine can run a reviewer (the participant owner decides that once): say so and lead to adding one.
  const router = useRouter();
  const serverId = props.accountLifetime.scope.serverId;
  return (
    <View testID="review-habit-reviewer-setup">
      {offersAgents ? recipeEditor : (
        <SurfaceStateCard testID="review-habit-no-machine" size="line" kind="unavailable"
          title={t('addFlows.addMachineDescription')}
          action={{ label: t('settings.addMachine'), onPress: () => router.push(buildMachineAddHref({ serverId }) as never) }} />
      )}
    </View>
  );
}

function useNewSessionProfileIntentId(): string | null {
  const scope = useAccountSettingsScope();
  const profilesShown = useSetting('useProfiles');
  const lastUsedProfile = useAuthoringMemoryField('lastUsedProfile');
  const { profiles } = useHomeAiLaunchProfileCatalog(scope);
  const migration = useProviderSettings(scope).migration;
  return React.useMemo(
    () =>
      resolveLaunchProfileAuthoringIntent({
        profileId: profilesShown && lastUsedProfile ? lastUsedProfile : null,
        profiles,
        migration,
      }).profileId,
    [lastUsedProfile, migration, profiles, profilesShown],
  );
}

/**
 * Session Info › Habits "Review my changes" (lab `session-habit`): Off · Each turn over the one Session trigger
 * that runs the built-in review. A saved habit switches through the trigger editor's own writer; the first
 * Each turn asks who reviews, then writes the trigger.
 */
export const ReviewHabitControl = React.memo(function ReviewHabitControl(
  props: Readonly<{
    /** While the Session's automations are still read, no option is drawn as chosen. */
    status: 'loading' | 'ready';
    row: AccountTriggerRow | null;
    pending: boolean;
    setup: React.ReactNode;
    onToggle: (row: AccountTriggerRow, next: boolean) => void;
    onSetUp: () => void;
    onOpenReviewers: (
      row: AccountTriggerRow,
      anchor: React.RefObject<View | null>,
    ) => void;
  }>,
) {
  const { row, onToggle, onSetUp, onOpenReviewers } = props;
  const anchorRef = React.useRef<View>(null);
  const value: Choice | null =
    props.status !== 'ready' ? null : row && !row.off ? 'eachTurn' : 'off';
  const options = React.useMemo(
    () => [
      {
        id: 'off' as const,
        label: t('common.off'),
        description: t('reviewWalkthrough.detail.reviewHabitOffDescription'),
      },
      {
        id: 'eachTurn' as const,
        label: t('reviewWalkthrough.detail.reviewHabitEachTurn'),
        description: t(
          'reviewWalkthrough.detail.reviewHabitEachTurnDescription',
        ),
      },
    ],
    [],
  );
  const change = React.useCallback(
    (next: Choice) => {
      if (row) onToggle(row, next === 'eachTurn');
      else if (next === 'eachTurn') onSetUp();
    },
    [row, onToggle, onSetUp],
  );
  return (
    <View ref={anchorRef} collapsable={false} testID="review-habit">
      <SegmentedChoiceItem<Choice>
        testID="review-habit-choice"
        testIDPrefix="review-habit"
        title={t('reviewWalkthrough.detail.reviewHabitTitle')}
        icon={<Icon name="check-square" />}
        options={options}
        value={value}
        onChange={change}
        accessoryLayout="stacked"
        disabled={props.pending || props.status !== 'ready'}
      />
      {props.setup}
      {row && !row.off ? (
        <Item
          testID="review-habit-reviewers"
          title={t('reviewWalkthrough.detail.reviewHabitReviewers')}
          subtitle={t('reviewWalkthrough.detail.reviewHabitReviewersDetail')}
          onPress={() => onOpenReviewers(row, anchorRef)}
        />
      ) : null}
    </View>
  );
});

/** The setup's one failure path: the trigger writer's own problem, said the way every trigger write says it. */
export function alertReviewHabitWriteFailed(error: unknown) {
  void Modal.alert(
    t('workflows.triggers.section.saveFailed'),
    formatWorkflowProblemMessage(error),
  );
}
