import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowWaitLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';

import { useSessionAuthoringEngineSummary } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { resolveEffectiveWorkflowStepExecution } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
  resolveWorkflowUnnamedHeading,
  workflowBlockReferenceLabel,
} from '@/sync/domains/workflows/workflowBlockLabel';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading } from './WorkflowBlockHeading';
import { formatWorkflowStepReturns } from './WorkflowStepDataEditor';
import { useWorkflowStepOptionsSummary } from './useWorkflowStepOptionsSummary';
import {
  WorkflowStepSessionDropZone,
  type WorkflowSessionDrop,
} from './WorkflowStepSessionDropZone';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * The least height a summary row holds (px), also before its words mount: its heading, one prompt
 * line and the line under it (a step's engine · options · returns, a Wait's caption).
 */
export const WORKFLOW_SUMMARY_ROW_ESTIMATE = { step: 66, wait: 66 } as const;

/** A prompt at rest shows up to this many lines before it ends in an ellipsis (lab E1). */
const SUMMARY_PROMPT_LINES = 3;

/**
 * A prompt block that is not being worked on (lab S1 "collapsed summary row", E1): its number, its
 * name, up to three lines of its prompt, a step's quiet engine · options · returns line, its
 * overflow actions, and the problem it has, if any.
 *
 * A long workflow mounts one block editor, not one per block: activating this row (a press, the
 * keyboard, or the page's "focus the first issue") selects the block, which then opens its editor
 * in place and puts the caret in its prompt.
 */
export function WorkflowBlockSummary(
  props: Readonly<{
    block: WorkflowStep | WorkflowWaitLeafV1;
    /** The block's written prompt. */
    summary: string;
    /** A step's workflow, for the engine and options it inherits; the line is left out without it. */
    draft?: WorkflowEditorDraft;
    authoringFacts?: SessionAuthoringControlFacts;
    ordinal: number;
    visibleOrdinal: string | null;
    total: number;
    actions: readonly WorkflowBlockAction[];
    /** The block's first issue, once the page reveals issues. */
    issue: string | null;
    onSelect: (blockId: string) => void;
    registerPromptRef?: (blockId: string, focus: (() => void) | null) => void;
    requestPromptFocus?: (blockId: string) => void;
    sessionDrop?: WorkflowSessionDrop;
    /** Whether this block sits in a lane; a Wait at the root pauses the workflow. */
    inLane: boolean;
    /**
     * Not reached yet by a pointer or the keyboard (PERF-WF3B): the row is only its words, and its
     * `⋯` a resting mark, until the list mounts its controls.
     */
    resting?: boolean;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { block, registerPromptRef } = props;
  const latestRef = React.useRef(props);
  latestRef.current = props;
  // Opening a summary hands focus to the editor it becomes: this row gives up its focus target
  // first, so the request waits for the prompt the opened editor registers.
  const activate = React.useCallback(() => {
    const current = latestRef.current;
    current.registerPromptRef?.(current.block.id, null);
    current.onSelect(current.block.id);
    current.requestPromptFocus?.(current.block.id);
  }, []);
  React.useEffect(() => {
    registerPromptRef?.(block.id, activate);
    return () => registerPromptRef?.(block.id, null);
  }, [registerPromptRef, block.id, activate]);

  const displayName = workflowBlockReferenceLabel(block);
  const rowPrefix = `${props.testIDPrefix}-${block.kind}-${block.id}`;
  const row = (
    <View
      testID={`${rowPrefix}-summary`}
      style={workflowEditorStyles.summaryBody}
    >
      <WorkflowBlockHeading
        ordinal={props.ordinal}
        visibleOrdinal={props.visibleOrdinal}
        unnamed={resolveWorkflowUnnamedHeading(block)}
        displayName={displayName}
        accessibilityLabel={t('workflows.a11y.stepContext', {
          block: displayName,
          position: props.ordinal,
          total: props.total,
        })}
        issue={props.issue}
        actions={props.actions}
        actionsResting={props.resting === true}
        onSelect={activate}
        testID={`${rowPrefix}-label`}
        actionsTestID={`${rowPrefix}-actions`}
      />
      {/* The prompt line is where a person reaches to keep writing, so it opens the editor as the
          name does. The name stays the one focusable control; this is the pointer's larger target. */}
      <Pressable
        testID={`${rowPrefix}-summary-prompt`}
        accessible={false}
        focusable={false}
        tabIndex={-1}
        onPress={activate}
        style={workflowEditorStyles.summaryPress}
      >
        <Text
          testID={`${rowPrefix}-summary-text`}
          numberOfLines={SUMMARY_PROMPT_LINES}
          style={workflowEditorStyles.summaryPrompt}
        >
          {props.summary}
        </Text>
        {block.kind === 'step' && props.draft !== undefined ? (
          <WorkflowStepSummaryMeta step={block} draft={props.draft} authoringFacts={props.authoringFacts}
            testID={`${rowPrefix}-summary-meta`} />
        ) : null}
        {block.kind === 'wait' ? (
          <Text style={workflowEditorStyles.metaText}>
            {t(props.inLane ? 'workflows.page.blocks.waitSub' : 'workflows.page.blocks.waitSubRoot')}
          </Text>
        ) : null}
        {props.issue === null ? null : (
          <View style={workflowEditorStyles.stepIssues}>
            <Text
              testID={`${rowPrefix}-issue`}
              style={workflowEditorStyles.issueText}
            >
              {props.issue}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
  // A Session carried onto a step binds its conversation whether or not the step is open.
  return block.kind === 'step' ? (
    <WorkflowStepSessionDropZone
      stepId={block.id}
      label={displayName}
      {...(props.sessionDrop === undefined
        ? {}
        : { sessionDrop: props.sessionDrop })}
      restingLayout={props.resting === true}
      testID={`${rowPrefix}-session-drop`}
    >
      {row}
    </WorkflowStepSessionDropZone>
  ) : (
    row
  );
}

/** A step at rest names what runs it and how, quietly (lab E1): "Opus 5.5 · Workflow defaults · Returns issues". */
function WorkflowStepSummaryMeta(props: Readonly<{
  step: WorkflowStep;
  draft: WorkflowEditorDraft;
  authoringFacts?: SessionAuthoringControlFacts;
  testID: string;
}>): React.ReactElement {
  const { step, draft } = props;
  const engine = useSessionAuthoringEngineSummary({
    values: resolveEffectiveWorkflowStepExecution(draft, step),
    engine: step.execution?.participant ?? step.execution?.engine ?? draft.defaults.engine,
    workflowRoles: draft.roles,
    ...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts }),
  });
  const options = useWorkflowStepOptionsSummary(draft, step);
  const line = [engine, options.label, formatWorkflowStepReturns(step.result)]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(' · ');
  return (
    <Text testID={props.testID} numberOfLines={1} style={workflowEditorStyles.metaText}>
      {line}
    </Text>
  );
}
