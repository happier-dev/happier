import * as React from 'react';

import {
  Action,
  AnchoredDiscussionThread,
  Banner,
  Divider,
  Icon,
  IconButton,
  Stack,
  Step,
  Row,
  Text,
  usePluginTranslation,
  WorkerUpdateCard,
} from '@happier-dev/plugin-ui';
import { isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import type { InternalTaskDetailDataV1 } from '../../internalTasks/detailData.js';
import type { TriageTaskClaimReleaseReasonV1 } from '../../internalTasks/claimRelease.js';

import type {
  TriageEditTaskPlacementV1,
  TriageTaskRelationChapterV1,
} from './taskFields.js';

export const TRIAGE_TASK_STORY_TEST_ID_V1 = 'triage-task-story';
export const TRIAGE_TASK_ACTIVITY_TEST_ID_V1 = 'triage-task-activity';
export const TRIAGE_TASK_REVIEW_TEST_ID_V1 = 'triage-task-review';

/**
 * A task's Overview as calm typographic sections (work-loop R3 `detail:A`): Notes, Blocked by, Sub-tasks, Activity, then
 * the agent's work, one shared left edge with a hairline between sections and no counted markers. The notes are the
 * source's own detail; the relations and the editor come from the task's one edit owner (`TriageEditTaskScope`); the
 * agent section is Triage's. A relation the source did not read has no section.
 */
export function TriageTaskStory(
  props: Readonly<{
    task: TriageEditTaskPlacementV1;
    /** The source's own detail for this task (its notes). */
    notes: React.ReactNode;
    /** The agent's work as the story's last section; `null` without a linked Session or an agent entry to offer. */
    renderAgentStep(): React.ReactNode;
    /** The task's own reference: a Happier Task's comments are its one host Discussion, after its relations. */
    entryRef?: TriageEntryRefV1;
    /** A Happier Task's own read (its state and the Run that last worked on it), from its exact-read `detailData`. */
    review?: InternalTaskDetailDataV1 | null;
    /** The positive fact that released this Task's claim (its Run ended or its Machine went offline); `null` while held. */
    claimRelease?: TriageTaskClaimReleaseReasonV1 | null;
  }>,
): React.ReactElement {
  const text = usePluginTranslation();
  const { task } = props;
  const relations: Array<readonly [string, TriageTaskRelationChapterV1]> = [];
  if (task.relations.blockedBy !== null) {
    relations.push(['blockedBy', task.relations.blockedBy]);
  }
  if (task.relations.subTasks !== null) {
    relations.push(['subTasks', task.relations.subTasks]);
  }
  const editLabel = text(
    'plugins.triage.tasks.editText',
    'Edit title and notes',
  );
  const agent = props.renderAgentStep();
  // Ready for review (work-loop R3 detail:A): the agent's finished report leads the story, and completing the task is
  // the view's one primary step, through the source's own completed transition.
  const readyForReview = props.review?.state === 'ready_for_review';
  const runLink = props.review?.runLink;
  const complete = readyForReview ? task.complete ?? null : null;
  const hero = runLink === undefined && complete === null ? null : (
    <Stack gap="small" testID={TRIAGE_TASK_REVIEW_TEST_ID_V1}>
      {runLink === undefined ? null : <WorkerUpdateCard run={runLink} />}
      {complete === null ? null : (
        <Row gap="small" align="center">
          <Action.Control action={complete.action} controller={complete.controller} variant="primary"
            title={text('plugins.triage.tasks.markCompleted', 'Mark completed')} disabled={complete.disabled} />
        </Row>
      )}
    </Stack>
  );
  // A released claim is said once, calmly, above the story: the Task is free again and nothing it kept is lost.
  const released = props.claimRelease == null ? null : (
    <Banner tone="info" title={text('plugins.triage.tasks.released.title', 'Released')}
      description={props.claimRelease === 'host_lost'
        ? text('plugins.triage.tasks.released.hostLost', 'The agent’s Machine went offline, so this task is free to take again. Nothing it already did is lost.')
        : text('plugins.triage.tasks.released.runEnded', 'The agent’s Run ended before it finished, so this task is free to take again. Nothing it already did is lost.')} />
  );
  return (
    <Stack gap="large" testID={TRIAGE_TASK_STORY_TEST_ID_V1}>
      {released}
      {hero}
      <Step
        title={text('plugins.triage.tasks.body', 'Notes')}
        trailing={
          task.edit === null || task.form !== null ? undefined : (
            <IconButton icon={<Icon name="edit" tone="secondary" size="small" />} accessibilityLabel={editLabel} disabled={task.edit.disabled} onPress={task.edit.open} />
          )
        }
      >
        {task.form ?? props.notes}
      </Step>
      {relations.map(([id, chapter]) => (
        <React.Fragment key={id}>
          <Divider />
          <Step
            title={chapter.title}
            {...(chapter.summary === undefined
              ? {}
              : {
                  trailing: (
                    <Text
                      variant="meta"
                      tone="secondary"
                      value={chapter.summary}
                    />
                  ),
                })}
          >
            {chapter.list('chapter')}
          </Step>
        </React.Fragment>
      ))}
      {props.entryRef === undefined || !isInternalTaskReferenceV1(props.entryRef) ? null : (
        <>
          <Divider />
          <Step title={text('plugins.triage.tasks.activity', 'Activity')}>
            {/* Who may read and post is the Task's; View only is the edit owner's own decision. An external
                item's private comments ride its source composer's Internal switch instead. */}
            <AnchoredDiscussionThread anchor={props.entryRef} readOnly={task.edit === null}
              testID={TRIAGE_TASK_ACTIVITY_TEST_ID_V1} />
          </Step>
        </>
      )}
      {agent === null ? null : (
        <>
          <Divider />
          {agent}
        </>
      )}
    </Stack>
  );
}
