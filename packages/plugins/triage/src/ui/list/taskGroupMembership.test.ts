import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1, triageEntryRowKey } from '../../projection/listWindow.js';
import { planTriageListItemsV1 } from './sections.js';
import { assignTriageTaskStatusGroup } from './taskGroupMembership.js';
import { triageEntrySessionDropTargetRuntime, triageTaskStatusDropTargetRuntime } from './entryDragDrop.js';

const vocabulary = { verb: 'Change status', unavailableReason: 'Use the status menu.' };
const capability = INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities!;
function taskItems(transitions = capability.transitions, materialized = true) {
  const observation = testkitObservation();
  const entryRef = testkitEntryRef({ kindId: 'task' });
  const rows = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs }).rows;
  return planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: () => 'issue',
    tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false,
      capabilitiesOf: () => ({ ...capability, transitions }) } }).map(item => materialized ? item
        : { ...item, row: { ...item.row, materialized: false, sourceInstanceId: null } });
}

it('uses the selected source’s one field-free transition, including an empty destination column', () => {
  const items = taskItems();
  const group = assignTriageTaskStatusGroup({ key: 'completed', title: 'Done' }, items, vocabulary);
  expect(items.every(item => item.task?.category !== 'completed')).toBe(true);
  expect(group.membership).toMatchObject({ kind: 'assignable', target: { targetId: 'task-status' } });
  if (group.membership?.kind !== 'assignable') throw new Error('Expected an assignable group');
  const item = items[0]!;
  const reference = { entryRef: item.row.entryRef,
    sourceInstance: { source: item.row.entryRef.source, sourceInstanceId: item.row.sourceInstanceId! },
    lastKnownLocator: item.locator!, title: item.row.title, subtitle: item.row.scopeLabel };
  const resolve = (value: JsonValue, targetInput = group.membership?.kind === 'assignable' ? group.membership.target.input ?? null : null) => triageTaskStatusDropTargetRuntime.resolve({
    item: { kind: 'plugin', scope: { serverId: 'home', accountId: 'account' },
      contribution: { pluginId: 'happier.triage', localId: 'entry-reference' }, reference: value },
    targetInput,
    destination: null, input: 'pointer',
  });
  expect(resolve(reference)).toMatchObject({ status: 'allowed', effect: {
    actionId: 'plugin:happier.triage/tasks/transition-v1',
    input: { entryRef: item.row.entryRef, transitionId: 'completed', sourceInstanceId: item.row.sourceInstanceId },
  } });
  expect(resolve({ ...reference, sourceInstance: { ...reference.sourceInstance,
    sourceInstanceId: '22222222-2222-4222-8222-222222222222' } })).toMatchObject({ status: 'refused' });
  expect(resolve({ ...reference, entryRef: { ...reference.entryRef, entryId: 'other' } })).toMatchObject({ status: 'refused' });
  expect(resolve({ title: 'Malformed' })).toMatchObject({ status: 'refused' });
  const input = group.membership.target.input;
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a status destination input');
  expect(resolve(reference, { ...input, candidatesByEntry: { [triageEntryRowKey(item.row.entryRef)]: { v: 1 } } }))
    .toMatchObject({ status: 'refused' });
});

it('leaves view-only, ambiguous, required-field, unread and current-category tasks to the existing status menu', () => {
  const completed = capability.transitions!.find(transition => transition.id === 'completed')!;
  for (const items of [taskItems([]), taskItems([completed, { ...completed, id: 'another-done' }]),
    taskItems([{ ...completed, requiredFields: [{ id: 'resolution', label: 'Resolution', kind: 'text' }] }]),
    taskItems(undefined, false), taskItems().map(item => ({ ...item, task: { ...item.task!, category: 'completed' as const } }))]) {
    const group = assignTriageTaskStatusGroup({ key: 'completed', title: 'Done' }, items, vocabulary);
    if (group.membership?.kind !== 'assignable') throw new Error('Expected a status destination');
    const input = group.membership.target.input;
    expect(input !== null && typeof input === 'object' && !Array.isArray(input) ? input.candidatesByEntry : null).toEqual({});
  }
});

it('settles Session linking from its own result schema, keeping failed and malformed results out of Applied', () => {
  const settle = triageEntrySessionDropTargetRuntime.settle!;
  expect(settle({ v: 1, status: 'linked' })).toEqual({ status: 'applied' });
  expect(settle({ v: 1, status: 'failed' })).toMatchObject({ status: 'unknown', reason: { code: 'triage_session_link_failed' } });
  expect(settle({ kind: 'applied' })).toMatchObject({ status: 'unknown' });
});
