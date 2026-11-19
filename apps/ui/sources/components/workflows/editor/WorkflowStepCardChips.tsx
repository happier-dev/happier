import * as React from 'react';
import { View } from 'react-native';

import type {
  WorkflowStep,
  WorkflowStepExecutionSelection,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type {
  SessionAuthoringControlFacts,
  SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SESSION_COMPOSER_CHIP_FIELDS } from '@/components/sessions/new/SessionServerStartDraftComposerBody';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { listWorkflowStepOverriddenFields } from '@/sync/domains/workflows/workflowAuthoring';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import type { WorkflowStepOptionChange } from './useWorkflowStepOptionsSummary';
import { WorkflowStepPlaceContext, WorkflowStepWorkspacePicker } from './WorkflowProjectTargetControl';
import { buildWorkflowStepWorkspace } from './workflowStepWorkspace';
import { WorkflowStepOptionsMore } from './WorkflowStepOptionsChip';
import {
  isWorkflowStepEngineOverridden,
  WORKFLOW_ENGINE_FIELD_IDS,
} from './WorkflowStepInspector';
import { workflowEditorStyles } from './workflowEditorStyles';

const ENGINE_FIELDS: readonly SessionAuthoringFieldId[] = Object.freeze([
  'agentTarget',
]);
const ENGINE_CHANGED: ReadonlySet<SessionAuthoringFieldId> = new Set([
  'agentTarget',
]);

/**
 * Who runs the step besides its engine (the composer's chips: service, permissions, approvals): always at the
 * card's foot, quiet while inherited and marked once the step changes them (owner 11-17, WF-REDESIGN-1116).
 */
const FOOT_SESSION_FIELDS: readonly SessionAuthoringFieldId[] = Object.freeze(
  SESSION_COMPOSER_CHIP_FIELDS.filter((field) => !(WORKFLOW_ENGINE_FIELD_IDS as readonly string[]).includes(field)),
);

/** The Session fields a step sets itself, other than its engine: each is a marked chip at its card's foot. */
export function listWorkflowStepSessionChanges(
  step: WorkflowStep,
): readonly SessionAuthoringFieldId[] {
  return listWorkflowStepOverriddenFields(step).filter(
    (field) =>
      !(WORKFLOW_ENGINE_FIELD_IDS as readonly string[]).includes(field),
  );
}

/**
 * An Agent step's header (round 1116b, step options A): its engine as the Session chip ("Claude ·
 * Opus 5.5"), quiet while the step inherits the workflow's and the bordered "Agent: …" chip once it
 * chooses its own. The same chip and picker the How card and the composer use.
 */
export function WorkflowStepEngineChip(
  props: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    effective: WorkflowStepExecutionSelection;
    engine: WorkflowEngineChoiceV1 | undefined;
    editable: boolean;
    onChangeExecutionFields?: (
      fields: Partial<WorkflowStepExecutionSelection>,
    ) => void;
    onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
    onResetEngine?: () => void;
    authoringFacts?: SessionAuthoringControlFacts;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const latest = React.useRef(props);
  latest.current = props;
  const onChangeFields = React.useCallback(
    (fields: Partial<WorkflowStepExecutionSelection>) =>
      latest.current.onChangeExecutionFields?.(fields),
    [],
  );
  const onChangeEngine = React.useCallback(
    (engine: WorkflowEngineChoiceV1) => latest.current.onChangeEngine?.(engine),
    [],
  );
  // A changed engine's picker leads with the way back to the workflow's.
  const resetOverride = React.useMemo(() => ({
    label: t('workflows.page.useWorkflowsValue'),
    onResetField: () => latest.current.onResetEngine?.(),
  }), []);
  return (
    <SessionAuthoringControls
      presentation="chips"
      fields={ENGINE_FIELDS}
      values={props.effective}
      {...(props.engine === undefined ? {} : { engine: props.engine })}
      workflowRoles={props.draft.roles}
      onChangeFields={onChangeFields}
      onChangeEngine={onChangeEngine}
      onChangeField={NO_FIELD_CHANGE}
      {...(isWorkflowStepEngineOverridden(props.step)
        ? { overriddenFields: ENGINE_CHANGED }
        : {})}
      overriddenAccessibilityHint={t('workflows.page.changedForStep')}
      resetOverride={resetOverride}
      disabled={!props.editable}
      {...(props.authoringFacts === undefined
        ? {}
        : { facts: props.authoringFacts })}
      testIDPrefix={props.testIDPrefix}
    />
  );
}

function NO_FIELD_CHANGE(): void {}

/**
 * The foot of an Agent step's card (round 1116b, step options A): only what the step changes, as
 * bordered chips, then "…" for the rest. A Session field opens its own picker; the step's other
 * options open the step's options beside the chip.
 */
export function WorkflowStepOptionChips(
  props: Readonly<{
    editable: boolean;
    step: WorkflowStep;
    effective: WorkflowStepExecutionSelection;
    changes: readonly WorkflowStepOptionChange[];
    onChangeExecutionField?: <
      TField extends keyof WorkflowStepExecutionSelection,
    >(
      field: TField,
      value: WorkflowStepExecutionSelection[TField] | undefined,
    ) => void;
    onOpenOptions: (anchorRef: React.RefObject<View | null>) => void;
    authoringFacts?: SessionAuthoringControlFacts;
    /** The workflow's Workspace as the step inherits it; the Workspace chip opens the checkout picker at step scope. */
    inheritedWorkspaceLabel?: string;
    /** The step's workflow, for the picker's "Same as the workflow" and "Where a step left it" rows. */
    draft?: WorkflowEditorDraft;
    /** A row nobody has reached yet (PERF-WF3B): "…" is not mounted until then. */
    optionsResting?: boolean;
    blockLabel: string;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const changedFields = React.useMemo(() => listWorkflowStepSessionChanges(props.step), [props.step]);
  const changedSet = React.useMemo(() => new Set(changedFields), [changedFields]);
  const sessionFields = React.useMemo(
    () => [...FOOT_SESSION_FIELDS, ...changedFields.filter((field) => !FOOT_SESSION_FIELDS.includes(field))],
    [changedFields],
  );
  const workspaceChange = props.changes.find((change) => change.id === 'workspace');
  const latest = React.useRef(props.onChangeExecutionField);
  latest.current = props.onChangeExecutionField;
  const onChangeField = React.useCallback(
    (field: SessionAuthoringFieldId, value: unknown) => {
      latest.current?.(field, value as never);
    },
    [],
  );
  const resetOverride = React.useMemo(() => ({
    label: t('workflows.page.useWorkflowsValue'),
    onResetField: (field: SessionAuthoringFieldId) => latest.current?.(field, undefined),
  }), []);
  return (
    <View style={workflowEditorStyles.stepOptionChips}>
      <View style={workflowEditorStyles.stepOptionChipList}>
        {sessionFields.length === 0 ? null : (
          <View style={workflowEditorStyles.stepSessionChipGroup}>
          <SessionAuthoringControls
            presentation="chips"
            fields={sessionFields}
            values={props.effective}
            onChangeField={onChangeField}
            overriddenFields={changedSet}
            engineChipBeside
            disabled={!props.editable}
            overriddenAccessibilityHint={t('workflows.page.changedForStep')}
            resetOverride={resetOverride}
            {...(props.authoringFacts === undefined
              ? {}
              : { facts: props.authoringFacts })}
            testIDPrefix={`${props.testIDPrefix}-session`}
          />
          </View>
        )}
        {workspaceChange === undefined && props.inheritedWorkspaceLabel === undefined ? null : (
          <WorkflowStepWorkspaceChip
            change={workspaceChange ?? { id: 'workspace', title: t('workflows.workspace.title'), value: props.inheritedWorkspaceLabel }}
            inherited={workspaceChange === undefined}
            step={props.step}
            {...(props.editable && props.draft !== undefined ? { draft: props.draft } : {})}
            onChangeWorkspace={(next) => latest.current?.('workspace', next)}
            onOpenOptions={props.onOpenOptions}
            testID={workspaceChange === undefined ? `${props.testIDPrefix}-workspace` : `${props.testIDPrefix}-changed-workspace`}
          />
        )}
        {props.changes.filter((change) => change.id !== 'workspace').map((change) => (
          <WorkflowStepOptionChangeChip
            key={change.id}
            change={change}
            onOpen={props.onOpenOptions}
            testID={`${props.testIDPrefix}-changed-${change.id}`}
          />
        ))}
      </View>
      {props.optionsResting === true ? null : (
        <WorkflowStepOptionsMore
          onOpen={props.onOpenOptions}
          blockLabel={props.blockLabel}
          testID={`${props.testIDPrefix}-customize`}
        />
      )}
    </View>
  );
}

/**
 * A step's Workspace chip: opens the sessions' checkout picker at step scope (round 1116b change a), mounted only
 * while open. A reader, or a workflow with no folder to pick a checkout of, opens the step's options instead.
 */
function WorkflowStepWorkspaceChip(
  props: Readonly<{
    change: WorkflowStepOptionChange;
    inherited: boolean;
    step: WorkflowStep;
    /** Absent for a reader: the chip opens the step's options. */
    draft?: WorkflowEditorDraft;
    onChangeWorkspace: (next: WorkflowStepExecutionSelection['workspace']) => void;
    onOpenOptions: (anchorRef: React.RefObject<View | null>) => void;
    testID: string;
  }>,
): React.ReactElement {
  const anchorRef = React.useRef<View>(null);
  const place = React.useContext(WorkflowStepPlaceContext);
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const { draft, step, onChangeWorkspace } = props;
  const latestChange = React.useRef(onChangeWorkspace);
  latestChange.current = onChangeWorkspace;
  const workspace = React.useMemo(() => !open || draft === undefined ? null
    : buildWorkflowStepWorkspace({ draft, step, write: (next) => latestChange.current(next) }), [draft, open, step]);
  const picks = draft !== undefined && place?.target != null && isWorkflowProjectTarget(place.target);
  return (
    <View ref={anchorRef} collapsable={false} style={workflowEditorStyles.stepChipAnchor}>
      <SelectionListFilterChip
        filter={{
          id: props.change.id,
          testID: props.testID,
          label: props.change.title,
          valueLabel: props.change.value ?? props.change.title,
          showLabel: props.change.value !== undefined,
          ...(props.inherited ? { muted: true } : { accessibilityHint: t('workflows.page.changedForStep') }),
          // The picker below is the chip's menu; the chip's own popover stays closed.
          open: false,
          onOpenChange: (next) => {
            if (!next) return;
            if (picks) setOpen(true);
            else props.onOpenOptions(anchorRef);
          },
          renderPopoverContent: () => null,
        }}
      />
      {workspace === null || place === null ? null : (
        <WorkflowStepWorkspacePicker place={place} workspace={workspace} anchorRef={anchorRef} onClose={close}
          testIDPrefix={props.testID} />
      )}
    </View>
  );
}

function WorkflowStepOptionChangeChip(
  props: Readonly<{
    change: WorkflowStepOptionChange;
    onOpen: (anchorRef: React.RefObject<View | null>) => void;
    testID: string;
  }>,
): React.ReactElement {
  const anchorRef = React.useRef<View>(null);
  return (
    <View ref={anchorRef} collapsable={false} style={workflowEditorStyles.stepChipAnchor}>
      <SelectionListFilterChip
        filter={{
          id: props.change.id,
          testID: props.testID,
          label: props.change.title,
          // "Conversation: Fresh"; an option with no value of its own reads as its name.
          valueLabel: props.change.value ?? props.change.title,
          showLabel: props.change.value !== undefined,
          accessibilityHint: t('workflows.page.changedForStep'),
          open: false,
          onOpenChange: (next) => {
            if (next) props.onOpen(anchorRef);
          },
          renderPopoverContent: () => null,
        }}
      />
    </View>
  );
}
