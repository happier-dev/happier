// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, expect, it } from 'vitest';

import type { TriageEditTaskPlacementV1 } from './taskFields.js';
import { createTaskActionControlTestkit as createPluginUiTestkit } from './taskActionControl.test-support.js';
import { TriageTaskStory } from './taskStory.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HAPPIER_TASK: TriageEntryRefV1 = {
  source: { pluginId: 'happier.triage', localId: 'internal' },
  kindId: 'task',
  collisionScope: 'personal',
  entryId: 'task-7',
} as TriageEntryRefV1;
const LINEAR_TASK: TriageEntryRefV1 = {
  source: { pluginId: 'happier.linear', localId: 'issues' },
  kindId: 'issue',
  collisionScope: 'workspace',
  entryId: 'ENG-12',
} as TriageEntryRefV1;

function placement(editable: boolean): TriageEditTaskPlacementV1 {
  return {
    status: null,
    controls: null,
    relations: { blockedBy: null, subTasks: null },
    form: null,
    edit: editable ? { open: () => {}, disabled: false } : null,
  };
}

const mounted: PluginUiTestkit[] = [];
const transitions: unknown[] = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((fixture) => fixture.dispose()));
});

async function mountStory(entryRef: TriageEntryRefV1, editable: boolean, extra: Partial<React.ComponentProps<typeof TriageTaskStory>> = {}, task = placement(editable)) {
  const surface = defineUiSurface(() => (
    <TriageTaskStory
      task={task}
      entryRef={entryRef}
      notes={null}
      renderAgentStep={() => null}
      {...extra}
    />
  ));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'task-story-activity',
        mountNonce: `${entryRef.entryId}-${editable}`,
      },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: (bindings) => createPluginUiRnwSemanticSurfaceAdapter({ hostWork: true, actionBindings: { commit: bindings.commit } }),
      handlers: { executeAction: ({ action, input }) => { transitions.push({ action, input }); return { status: 'applied' } as never; } },
    });
  });
  mounted.push(fixture);
  return fixture;
}

it('ends a Happier Task story with its comments in the host thread, writable for a person who can edit the Task', async () => {
  const fixture = await mountStory(HAPPIER_TASK, true);
  expect(
    await fixture.getByRole('group', { name: 'Comments on task-7' }),
  ).toBeTruthy();
  expect(await fixture.getByRole('textbox', { name: 'Comment' })).toBeTruthy();
  expect(document.body.textContent).toContain('Activity');
});

it('passes the Task owner’s View only through, so the thread offers no composer', async () => {
  const fixture = await mountStory(HAPPIER_TASK, false);
  expect(
    await fixture.getByRole('group', { name: 'Comments on task-7, read only' }),
  ).toBeTruthy();
  expect(await fixture.queryByRole('textbox', { name: 'Comment' })).toBeUndefined();
});

it('leaves an external task’s private comments to its source composer', async () => {
  const fixture = await mountStory(LINEAR_TASK, true);
  expect(
    await fixture.queryByRole('group', { name: 'Comments on ENG-12' }),
  ).toBeUndefined();
  expect(document.body.textContent).not.toContain('Activity');
});

const COMPLETE = { label: 'Done', disabled: false, action: 'tasks/transition-v1',
  controller: { prepare: () => ({ input: { transitionId: 'done' } }), onSettled: () => {} } };

it('leads a Ready for review Task with the agent’s Run report and Mark completed as its one primary step', async () => {
  const fixture = await mountStory(HAPPIER_TASK, true, { review: { state: 'ready_for_review', runLink: { sessionId: 'lead', runId: 'run-7' } } },
    { ...placement(true), complete: COMPLETE });
  expect(await fixture.getByRole('group', { name: 'Run report run-7' })).toBeTruthy();
  expect(await fixture.getByRole('button', { name: 'Mark completed' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text.indexOf('Run report')).toBeLessThan(text.indexOf('Notes'));
  transitions.length = 0;
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Mark completed' })); });
  expect(transitions).toHaveLength(1);
});

it('keeps the report but offers no Mark completed outside Ready for review', async () => {
  const fixture = await mountStory(HAPPIER_TASK, true, { review: { state: 'started', runLink: { sessionId: 'lead', runId: 'run-7' } } },
    { ...placement(true), complete: COMPLETE });
  expect(await fixture.getByRole('group', { name: 'Run report run-7' })).toBeTruthy();
  expect(await fixture.queryByRole('button', { name: 'Mark completed' })).toBeUndefined();
});

it('says calmly when a Task’s claim was released, and says nothing while it is held', async () => {
  const released = await mountStory(HAPPIER_TASK, true, { claimRelease: 'host_lost' });
  const notice = Array.from(document.querySelectorAll('[role="status"]')).map(node => node.textContent ?? '').join(' ');
  expect(notice).toContain('Released');
  expect(notice).toContain('went offline');
  await released.dispose();
  mounted.splice(mounted.indexOf(released), 1);
  await mountStory(HAPPIER_TASK, true, { claimRelease: null });
  expect(document.body.textContent).not.toContain('Released');
});
