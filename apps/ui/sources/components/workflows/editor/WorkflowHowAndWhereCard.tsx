import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readWorkflowEngineChoiceV1, resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { setWorkflowDefaultField, setWorkflowInputs } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowWorkspaceSelection } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { workflowInputToFieldHint } from '@happier-dev/protocol/workflows/workflowV1';

import {
  SessionAuthoringControls,
  useSessionAuthoringEngineSummary,
} from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import {
  readSessionAuthoringAgentTargetValue,
  retireUnavailableSessionAuthoringRuntimeDescriptor,
  type SessionAuthoringControlFacts,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SESSION_COMPOSER_CHIP_FIELDS } from '@/components/sessions/new/SessionServerStartDraftComposerBody';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { workflowDefaultsChooseAgent, type WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';

import type {
  WorkflowRunAsTarget,
  WorkflowRunAsTargetKind,
} from '../run/workflowRunAsTargets';
import { WorkflowContinuityControls } from './WorkflowContinuityControls';
import {
  useWorkflowEditorSelector,
  type WorkflowEditorDraftStore,
} from './workflowEditorDraftStore';
import { WorkflowInputsEditor } from './WorkflowInputsEditor';
import { WorkflowCardGutterRow, WorkflowKindCard } from './WorkflowKindCard';
import { WorkflowMoreSettings } from './WorkflowMoreSettings';
import { renderWorkflowCardFieldRow } from './workflowCardFieldRow';
import {
  formatWorkflowWhereSummary,
  WorkflowProjectTargetControl,
  type WorkflowProjectTargetControlHandle,
  type WorkflowWhereRowRenderer,
} from './WorkflowProjectTargetControl';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import type { WorkflowSessionDrop } from './useWorkflowSessionBinding';
import { workflowEditorStyles } from './workflowEditorStyles';
import { formatWorkflowFieldLabel } from '../presentation/workflowValuePresentation';

const styles = StyleSheet.create((theme) => ({
  /** One meaning per group (lab round 1116: Where it runs, Who runs it, Each step, Workflow inputs), a hairline between them. */
  group: {
    gap: theme.space.s4,
    paddingVertical: theme.space.s8,
  },
  groupRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  groupTitle: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
    paddingBottom: theme.space.s4,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  readOnlyValue: {
    ...Typography.variant('label'),
    color: theme.colors.text.primary,
  },
}));

const readDefaults = (draft: WorkflowEditorDraft) => draft.defaults;
const readRoles = (draft: WorkflowEditorDraft) => draft.roles;
const readInputs = (draft: WorkflowEditorDraft) => draft.inputs;

/** Machine, Folder and Workspace on the card's label track. */
const renderWhereRow: WorkflowWhereRowRenderer = renderWorkflowCardFieldRow;

/**
 * "How and where it runs" (lab round 1116b with owner changes a–e): the page's second first card and the
 * one place for how the workflow runs. Where it runs (Machine, Folder and the Session checkout picker as
 * Workspace), Who runs it (New Session's composer chips as field selects), Each step (Runs in and
 * Conversation), the Workflow inputs table, and More settings for the long tail. Each part is its one
 * owner's; each group reads only its own draft slice.
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
    /** Conversation: an existing Session to continue, through the host's Session candidacy owner. */
    existingSessions?: readonly WorkflowExistingSessionOption[];
    sessionOptionsStatus?: React.ComponentProps<typeof WorkflowContinuityControls>['sessionOptionsStatus'];
    onRetrySessionOptions?: () => void;
    onSessionOptionsDemandChange?: (demanded: boolean) => void;
    bindExistingSession?: WorkflowSessionDrop['bind'];
    /** Saved source only: More settings' Last run. */
    workflowDefinitionId?: string;
    description?: string;
    onChangeDescription?: (next: string) => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
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
  const readOnly = !props.documentEditable;

  // The workflow's Workspace is the Session checkout picker's choice (change a), written to its defaults.
  const workspace = React.useMemo(() => ({
    value: defaults.workspace,
    ...(readOnly ? {} : {
      onChange: (next: WorkflowWorkspaceSelection) => onChange(setWorkflowDefaultField(readDraft(), 'workspace', next)),
    }),
  }), [defaults.workspace, onChange, readDraft, readOnly]);

  // Who runs it: the composer's own chips and writers, as the Workflow settings agent group wrote them.
  const changeEngine = React.useCallback<NonNullable<React.ComponentProps<typeof SessionAuthoringControls>['onChangeEngine']>>((engine) => {
    if (readOnly) return;
    const draft = readDraft();
    onChange({ ...draft, defaults: withWorkflowAuthoringEngine(draft.defaults, engine) });
  }, [onChange, readDraft, readOnly]);
  const changeFields = React.useCallback<NonNullable<React.ComponentProps<typeof SessionAuthoringControls>['onChangeFields']>>((fields) => {
    if (readOnly) return;
    const draft = readDraft();
    let next = { ...draft, defaults: withWorkflowAuthoringEngineFields(draft.defaults, fields) };
    const retired = retireUnavailableSessionAuthoringRuntimeDescriptor({
      runtimeDescriptorV1: draft.defaults.runtimeDescriptorV1,
      agentTarget: fields.agentTarget ?? draft.defaults.agentTarget, facts: props.authoringFacts,
    });
    if (retired !== draft.defaults.runtimeDescriptorV1) next = setWorkflowDefaultField(next, 'runtimeDescriptorV1', retired);
    onChange(next);
  }, [onChange, props.authoringFacts, readDraft, readOnly]);
  const changeField = React.useCallback<React.ComponentProps<typeof SessionAuthoringControls>['onChangeField']>((field, value) => {
    if (readOnly) return;
    const draft = readDraft();
    let next = setWorkflowDefaultField(draft, field, value);
    if (field === 'agentTarget') {
      const retired = retireUnavailableSessionAuthoringRuntimeDescriptor({
        runtimeDescriptorV1: draft.defaults.runtimeDescriptorV1,
        agentTarget: readSessionAuthoringAgentTargetValue(value),
        facts: props.authoringFacts,
      });
      if (retired !== draft.defaults.runtimeDescriptorV1) next = setWorkflowDefaultField(next, 'runtimeDescriptorV1', retired);
    }
    onChange(next);
  }, [onChange, props.authoringFacts, readDraft, readOnly]);

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
      >
        <View style={styles.group} testID={`${id}-where`}>
          <Text style={styles.groupTitle}>
            {t('workflows.page.sections.whereTitle')}
          </Text>
          <View testID={`${props.testIDPrefix}-where-chips`}>
          <WorkflowProjectTargetControl
            accountLifetime={props.accountLifetime}
            purpose="workflow"
            ref={props.whereRef}
            presentation="rows"
            renderRow={renderWhereRow}
            workspace={workspace}
            target={props.projectTarget}
            machineName={props.machineName}
            {...(props.projectMachines === undefined
              ? {}
              : { machines: props.projectMachines })}
            {...(readOnly || props.onChangeProjectTarget === undefined
              ? {}
              : { onChange: props.onChangeProjectTarget })}
            testIDPrefix={props.testIDPrefix}
          />
          </View>
        </View>
        {!props.showsWorkflowAgent ? null : (
          <View style={[styles.group, styles.groupRule]} testID={`${id}-who`}>
            <Text style={styles.groupTitle}>
              {t('workflows.page.sections.groupWho')}
            </Text>
            <SessionAuthoringControls
              presentation="selects"
              disabled={readOnly}
              fields={SESSION_COMPOSER_CHIP_FIELDS}
              values={values}
              engine={readWorkflowEngineChoiceV1(defaults)}
              workflowRoles={roles}
              onChangeEngine={changeEngine}
              onChangeFields={changeFields}
              onChangeField={changeField}
              {...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts })}
              testIDPrefix={`${props.testIDPrefix}-header-engine`}
            />
          </View>
        )}
        <View style={[styles.group, styles.groupRule]} testID={`${id}-each-step`}>
          <Text style={styles.groupTitle}>
            {t('workflows.page.sections.groupEachStep')}
          </Text>
          {runsInTabs.length === 0 ||
          props.onChangeExecutionTarget === undefined ? null : (
            <View style={workflowEditorStyles.actionFieldRow}>
              <WorkflowFieldPair
                label={t('workflows.page.sections.runsInRow')}
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
                ) : (
                  // A read-only value, not a disabled choice with a reason that asks to choose (M7).
                  <Text testID={`${props.testIDPrefix}-run-as-readonly`} style={styles.readOnlyValue}>
                    {background ? t('workflows.page.sections.aBackgroundRun') : t('workflows.page.sections.aSession')}
                  </Text>
                )}
                {/* An unavailable class stays visible with its reason; never downgraded. */}
                {props.documentEditable && runsInReasons.length > 0 ? (
                  <Text style={styles.note}>{runsInReasons.join(' ')}</Text>
                ) : null}
              </WorkflowFieldPair>
            </View>
          )}
          {readOnly ? null : (
            <WorkflowDefaultsConversation
              draftStore={props.draftStore}
              {...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions })}
              onSessionOptionsDemandChange={props.onSessionOptionsDemandChange}
              sessionOptionsStatus={props.sessionOptionsStatus}
              onRetrySessionOptions={props.onRetrySessionOptions}
              onChangeConversation={(value) => onChange(setWorkflowDefaultField(readDraft(), 'conversation', value))}
              {...(props.bindExistingSession === undefined ? {} : {
                onBindExistingSession: (sessionId: string) => props.bindExistingSession!(null, sessionId),
              })}
              onChangeWorkspace={(value) => onChange(setWorkflowDefaultField(readDraft(), 'workspace', value))}
              testIDPrefix={`${props.testIDPrefix}-defaults-continuity`}
            />
          )}
        </View>
        <View style={[styles.group, styles.groupRule]} testID={`${id}-asks`}>
          {props.documentEditable ? (
            <WorkflowInputsEditor
              title={t('workflows.inputs.title')}
              note={t('workflows.page.sections.asksNote')}
              inputs={inputs}
              onChange={(next) => onChange(setWorkflowInputs(readDraft(), next))}
              testIDPrefix={props.testIDPrefix}
            />
          ) : (
            <>
              <Text style={styles.groupTitle}>
                {t('workflows.inputs.title')}
              </Text>
              {/* Read-only, the declared inputs read by their titles, never their wire keys. */}
              {inputs.map((input) => (
                <Text key={input.name} style={workflowEditorStyles.metaText}>
                  {formatWorkflowFieldLabel(input.name, workflowInputToFieldHint(input).title)}
                </Text>
              ))}
              <Text style={styles.note}>{t('workflows.page.sections.asksNote')}</Text>
            </>
          )}
        </View>
        <WorkflowMoreSettings
          draftStore={props.draftStore}
          onChange={onChange}
          documentEditable={props.documentEditable}
          authoringFacts={props.authoringFacts}
          {...(props.workflowDefinitionId === undefined ? {} : { workflowDefinitionId: props.workflowDefinitionId })}
          {...(props.description === undefined ? {} : { description: props.description })}
          {...(props.onChangeDescription === undefined ? {} : { onChangeDescription: props.onChangeDescription })}
          testIDPrefix={props.testIDPrefix}
        />
      </WorkflowKindCard>
    </WorkflowCardGutterRow>
  );
}

const readWholeDraft = (draft: WorkflowEditorDraft) => draft;

/**
 * Each step's Conversation, the conversation part of the continuity owner on the card's label track.
 * The owner reads the whole draft (it names a continued step's conversation), so only this leaf
 * subscribes to it; the card keeps its own slices.
 */
function WorkflowDefaultsConversation(
  props: Readonly<{ draftStore: WorkflowEditorDraftStore }>
    & Omit<React.ComponentProps<typeof WorkflowContinuityControls>, 'draft' | 'conversation' | 'workspace' | 'layout' | 'parts'>,
): React.ReactElement {
  const { draftStore, ...controls } = props;
  const draft = useWorkflowEditorSelector(draftStore, readWholeDraft);
  return (
    <WorkflowContinuityControls
      {...controls}
      layout="track"
      parts="conversation"
      draft={draft}
      conversation={draft.defaults.conversation}
      workspace={draft.defaults.workspace}
    />
  );
}
