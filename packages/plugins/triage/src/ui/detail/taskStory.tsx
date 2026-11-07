import * as React from 'react';

import {
  Icon,
  IconButton,
  Stack,
  Step,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import type {
  TriageEditTaskPlacementV1,
  TriageTaskRelationChapterV1,
} from './taskFields.js';

export const TRIAGE_TASK_STORY_TEST_ID_V1 = 'triage-task-story';

/**
 * A task's Overview as one numbered story (lab t1 `tasks-detail-personal`): ① Notes, ② Blocked by, ③ Sub-tasks, then
 * the agent's work. The notes are the source's own detail; the relations and the editor come from the task's one
 * edit owner (`TriageEditTaskScope`); the agent step is Triage's. A relation the source did not read has no chapter,
 * and the chapters count only what is there.
 */
export function TriageTaskStory(
  props: Readonly<{
    task: TriageEditTaskPlacementV1;
    /** The source's own detail for this task (its notes). */
    notes: React.ReactNode;
    /** The agent's work, given its place in the story; `null` without a linked Session. */
    renderAgentStep(number: number): React.ReactNode;
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
  return (
    <Stack gap="large" testID={TRIAGE_TASK_STORY_TEST_ID_V1}>
      <Step
        marker={{ kind: 'number', value: 1 }}
        title={text('plugins.triage.tasks.body', 'Notes')}
        trailing={
          task.edit === null || task.form !== null ? undefined : (
            <IconButton icon={<Icon name="edit" tone="secondary" size="small" />} accessibilityLabel={editLabel} disabled={task.edit.disabled} onPress={task.edit.open} />
          )
        }
      >
        {task.form ?? props.notes}
      </Step>
      {relations.map(([id, chapter], index) => (
        <Step
          key={id}
          marker={{ kind: 'number', value: index + 2 }}
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
      ))}
      {props.renderAgentStep(relations.length + 2)}
    </Stack>
  );
}
