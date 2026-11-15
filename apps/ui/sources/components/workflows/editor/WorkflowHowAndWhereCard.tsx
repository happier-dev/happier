import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1,
} from '@happier-dev/plugin-ui/presentation';
import { readWorkflowEngineChoiceV1, resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { setWorkflowInputs } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { workflowInputToFieldHint } from '@happier-dev/protocol/workflows/workflowV1';

import { useSessionAuthoringEngineSummary } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { workflowDefaultsChooseAgent } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';

import type {
  WorkflowRunAsTarget,
  WorkflowRunAsTargetKind,
} from '../run/workflowRunAsTargets';
import { WorkflowDefaultEngineControls } from './WorkflowDefaultEngineControls';
import {
  useWorkflowEditorSelector,
  type WorkflowEditorDraftStore,
} from './workflowEditorDraftStore';
import { WorkflowInputsEditor } from './WorkflowInputsEditor';
import { WorkflowCardGutterRow, WorkflowKindCard } from './WorkflowKindCard';
import {
  formatWorkflowWhereSummary,
  WorkflowProjectTargetControl,
  type WorkflowProjectTargetControlHandle,
} from './WorkflowProjectTargetControl';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';
import { formatWorkflowFieldLabel } from '../presentation/workflowValuePresentation';

const styles = StyleSheet.create((theme) => ({
  /** One meaning per group (lab r16 "Where", "How", "Asks for"), a hairline between them. */
  group: {
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
  groupRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  groupTitle: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s12,
    rowGap: theme.space.s4,
    minWidth: 0,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  asksNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  settingsAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s4,
    borderRadius: theme.borderRadius.sm,
  },
  settingsLabel: {
    ...Typography.variant('label'),
    color: theme.colors.text.primary,
  },
}));

const readDefaults = (draft: WorkflowEditorDraft) => draft.defaults;
const readRoles = (draft: WorkflowEditorDraft) => draft.roles;
const readInputs = (draft: WorkflowEditorDraft) => draft.inputs;

/**
 * "How and where it runs" (owner 2026-11-15, lab round 1115 r16 "Two cards"): the page's second
 * first card. Where (Machine and folder), How (the workflow's Agent and model, what each step runs
 * in) and what a run asks for, each through its one owner — the Where control, the shared Session
 * engine chips, the run-as choice and the inputs editor. Its header says it all in one sentence and
 * opens Workflow settings for everything else. Each group reads only its own draft slice.
 */
export function WorkflowHowAndWhereCard(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (next: WorkflowEditorDraft) => void;
    documentEditable: boolean;
    showsWorkflowAgent: boolean;
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    whereRef: React.RefObject<WorkflowProjectTargetControlHandle | null>;
    projectTarget: WorkflowAuthoringTarget | null | undefined;
    machineName: string | null;
    projectMachines: readonly Machine[] | undefined;
    onChangeProjectTarget:
      | ((target: WorkflowAuthoringTarget) => void)
      | undefined;
    executionTarget: WorkflowRunAsTargetKind | undefined;
    runAsTargets: readonly WorkflowRunAsTarget[] | undefined;
    onChangeExecutionTarget:
      | ((kind: WorkflowRunAsTargetKind) => void)
      | undefined;
    authoringFacts: SessionAuthoringControlFacts | undefined;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    /** Where Workflow settings sits: this card's control, which the page also opens it beside. */
    settingsAnchorRef: React.RefObject<View | null>;
    /** Absent where the host shows Workflow settings in place: the card has no control for it. */
    onOpenSettings?: () => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const id = `${props.testIDPrefix}-how-where`;
  const defaults = useWorkflowEditorSelector(props.draftStore, readDefaults);
  const roles = useWorkflowEditorSelector(props.draftStore, readRoles);
  const inputs = useWorkflowEditorSelector(props.draftStore, readInputs);
  const values = React.useMemo(
    () =>
      resolveWorkflowStepSelectionV1({ defaults, purpose: 'authoring' })
        .selection,
    [defaults],
  );
  const agent = useSessionAuthoringEngineSummary({
    values,
    engine: readWorkflowEngineChoiceV1(defaults),
    workflowRoles: roles,
    ...(props.authoringFacts === undefined
      ? {}
      : { facts: props.authoringFacts }),
  });
  const where = formatWorkflowWhereSummary({
    target: props.projectTarget,
    machineName: props.machineName,
    machineHomeDir:
      props.projectMachines?.find(
        (machine) => machine.id === props.projectTarget?.machineId,
      )?.metadata?.homeDir ?? null,
  });
  // The sentence names the workflow's Agent only once one is chosen and a step uses it; it never
  // quotes the picker's "Choose an agent" placeholder (QA-WAVE-1115).
  const agentClause =
    props.showsWorkflowAgent && workflowDefaultsChooseAgent(defaults)
      ? agent
      : null;
  const executionTarget = props.executionTarget ?? 'session';
  const background = executionTarget === 'detached_run';
  const summary =
    where === null
      ? t(
          background
            ? 'workflows.page.sections.howWhereNoMachineBackground'
            : 'workflows.page.sections.howWhereNoMachineSession',
          { agent: agentClause },
        )
      : t(
          background
            ? 'workflows.page.sections.howWhereBackground'
            : 'workflows.page.sections.howWhereSession',
          { where, agent: agentClause },
        );
  const { onOpenSettings } = props;
  const runsInTabs = React.useMemo(
    () =>
      (props.runAsTargets ?? []).map((target) => ({
        id: target.kind,
        label:
          target.kind === 'detached_run'
            ? t('workflows.page.sections.aBackgroundRun')
            : t('workflows.page.sections.aSession'),
        // An unavailable class stays visible with its reason; never downgraded.
        disabled: !target.available,
        ...(target.available
          ? {}
          : {
              unavailableReason: t(
                `workflows.page.unavailable.${target.unavailableReason}`,
              ),
            }),
      })),
    [props.runAsTargets],
  );
  const runsInReasons = runsInTabs.flatMap((tab) => ('unavailableReason' in tab && tab.unavailableReason !== undefined ? [tab.unavailableReason] : []));
  const readDraft = props.draftStore.get;
  const { onChange } = props;

  return (
    <WorkflowCardGutterRow icon="laptop">
      <WorkflowKindCard
        testID={id}
        title={t('workflows.page.sections.howWhereTitle')}
        summary={summary}
        disclosure={{
          expanded: props.expanded,
          onExpandedChange: props.onExpandedChange,
        }}
        headerAction={
          onOpenSettings === undefined ? undefined : (
            <View ref={props.settingsAnchorRef} collapsable={false}>
              <HappierPressable
                testID={`${id}-settings`}
                accessibilityRole="button"
                accessibilityLabel={t('workflows.page.settings')}
                hasPopup="dialog"
                onPress={onOpenSettings}
                style={(state) => [
                  styles.settingsAction,
                  state.pressed
                    ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
                    : null,
                  focusRingStyle({
                    focused: state.focused,
                    color: theme.colors.border.focus,
                  }),
                ]}
              >
                <Icon
                  name="sliders-horizontal"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
                <Text style={styles.settingsLabel}>
                  {t('workflows.page.settings')}
                </Text>
              </HappierPressable>
            </View>
          )
        }
      >
        <View style={styles.group} testID={`${id}-where`}>
          <Text style={styles.groupTitle}>
            {t('workflows.page.sections.groupWhere')}
          </Text>
          <View style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair
              label={t('workflows.page.sections.machineAndFolder')}
              trackKey="where"
            >
              <WorkflowProjectTargetControl
                accountLifetime={props.accountLifetime}
                purpose="workflow"
                ref={props.whereRef}
                presentation="value"
                target={props.projectTarget}
                machineName={props.machineName}
                {...(props.projectMachines === undefined
                  ? {}
                  : { machines: props.projectMachines })}
                {...(!props.documentEditable ||
                props.onChangeProjectTarget === undefined
                  ? {}
                  : { onChange: props.onChangeProjectTarget })}
                testIDPrefix={props.testIDPrefix}
              />
            </WorkflowFieldPair>
          </View>
        </View>
        <View style={[styles.group, styles.groupRule]} testID={`${id}-how`}>
          <Text style={styles.groupTitle}>
            {t('workflows.page.sections.groupHow')}
          </Text>
          {!props.showsWorkflowAgent ? null : (
            <View style={workflowEditorStyles.actionFieldRow}>
              <WorkflowFieldPair
                label={t('workflows.page.sections.agentRow')}
                trackKey="agent"
              >
                <View style={styles.chips}>
                  <WorkflowDefaultEngineControls
                    defaults={defaults}
                    roles={roles}
                    readDraft={readDraft}
                    onChange={onChange}
                    editable={props.documentEditable}
                    {...(props.authoringFacts === undefined
                      ? {}
                      : { facts: props.authoringFacts })}
                    testIDPrefix={`${props.testIDPrefix}-header-engine`}
                  />
                </View>
              </WorkflowFieldPair>
            </View>
          )}
          {runsInTabs.length === 0 ||
          props.onChangeExecutionTarget === undefined ? null : (
            <View style={workflowEditorStyles.actionFieldRow}>
              <WorkflowFieldPair
                label={t('workflows.page.sections.eachStepRunsIn')}
                trackKey="runs-in"
              >
                {props.documentEditable ? (
                  <SegmentedTabBar<WorkflowRunAsTargetKind>
                    tabs={runsInTabs}
                    activeTabId={executionTarget}
                    onSelectTab={(next) => props.onChangeExecutionTarget?.(next)}
                    segmentSizing="content"
                    accessibilityLabel={t('workflows.page.sections.eachStepRunsIn')}
                    role="radiogroup"
                    testIDPrefix={`${props.testIDPrefix}-run-as`}
                  />
                ) : null}
                {/* An unavailable class stays visible with its reason; never downgraded. */}
                {props.documentEditable && runsInReasons.length > 0 ? (
                  <Text style={styles.asksNote}>{runsInReasons.join(' ')}</Text>
                ) : null}
                {props.documentEditable ? null : (
                  // A read-only value, not a disabled choice with a reason that asks to choose (M7).
                  <Text testID={`${props.testIDPrefix}-run-as-readonly`} style={styles.settingsLabel}>
                    {background ? t('workflows.page.sections.aBackgroundRun') : t('workflows.page.sections.aSession')}
                  </Text>
                )}
              </WorkflowFieldPair>
            </View>
          )}
        </View>
        <View style={[styles.group, styles.groupRule]} testID={`${id}-asks`}>
          {props.documentEditable ? (
            <WorkflowInputsEditor
              title={t('workflows.page.sections.groupAsks')}
              inputs={inputs}
              onChange={(next) => onChange(setWorkflowInputs(readDraft(), next))}
              testIDPrefix={props.testIDPrefix}
            />
          ) : (
            <>
              <Text style={styles.groupTitle}>
                {t('workflows.page.sections.groupAsks')}
              </Text>
              {/* Read-only, the declared inputs read by their titles, never their wire keys. */}
              {inputs.map((input) => (
                <Text key={input.name} style={workflowEditorStyles.metaText}>
                  {formatWorkflowFieldLabel(input.name, workflowInputToFieldHint(input).title)}
                </Text>
              ))}
            </>
          )}
          <Text style={styles.asksNote}>
            {t('workflows.page.sections.asksNote')}
          </Text>
        </View>
      </WorkflowKindCard>
    </WorkflowCardGutterRow>
  );
}
