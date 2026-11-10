// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, DragSource, DropTarget, type DragSourceProps, type DropTargetProps } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { testkitEntryRef, testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import type { TriageListItemV1 } from './sections.js';
import { useTriageListAnatomyV1 } from './rows.js';
import type { PersonalTaskOrder } from './usePersonalTaskOrder.js';
import { triagePersonalTaskOrderTargetRuntime } from './entryDragDrop.js';
import { assignTriageTaskStatusGroup } from './taskGroupMembership.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { triageTaskStatusCategoryV1 } from '@happier-dev/triage-protocol/v1';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

function entry(materialized = true): TriageListItemV1 {
  return {
    key: 'entry-17', group: 'inReview', statusGroup: 'inReview', summary: null, signal: null,
    row: {
      key: 'entry-17', entryRef: testkitEntryRef(), title: 'Review the normalizer', scopeLabel: 'example/repository',
      detail: null, tone: 'neutral', detailKind: null, lifecyclePresentation: 'active', activityAtMs: null,
      kindId: 'pull-request', lifecycleLabel: 'Open', observedAtMs: 1, stale: false, pinned: false,
      materialized, sourceInstanceId: materialized ? '11111111-1111-4111-8111-111111111111' : null,
    },
    ...(materialized ? { locator: testkitLocator() } : {}),
  };
}

async function renderAnatomy(item: TriageListItemV1, organizing = false, tasks = false,
  personalTaskOrder?: PersonalTaskOrder, taskItems?: readonly TriageListItemV1[],
  taskGroupOf?: Parameters<typeof useTriageListAnatomyV1>[0]['taskGroupOf']) {
  let source: DragSourceProps | null = null;
  let target: DropTargetProps | null = null;
  const surface = defineUiSurface(function Probe() {
    const anatomy = useTriageListAnatomyV1({ withSignal: false, organizing, tasks, personalTaskOrder, taskItems, taskGroupOf });
    const content = <Text value="The Collection still owns this row" />;
    const wrapped = anatomy.wrapItem?.(item, content) ?? content;
    // Inspect the public author boundary, then mount its actual children through
    // the public renderer. Physical carry and Action policy are host-owned tests.
    if (React.isValidElement<DragSourceProps>(wrapped) && wrapped.type === DragSource) {
      source = wrapped.props;
      const nested = wrapped.props.children;
      if (React.isValidElement<DropTargetProps>(nested) && nested.type === DropTarget) target = nested.props;
    }
    return wrapped;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'triage-drag-test', mountNonce: 'triage-drag-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface, surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
    });
  });
  mounted.push(fixture);
  await expect(fixture.getByText('The Collection still owns this row')).resolves.toBeDefined();
  return { source, target } as Readonly<{ source: DragSourceProps | null; target: DropTargetProps | null }>;
}

describe('the real PR Collection public drag/drop binding', () => {
  it('uses the Collection status axis on cards while keeping same-column manual ordering', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    const base = entry();
    const task = (id: string, group: 'unstarted' | 'started'): TriageListItemV1 => ({ ...base, key: id, group, statusGroup: group,
      task: { category: group, statusLabel: null, relations: null, transitions: INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities!.transitions?.map(transition => ({ ...transition, category: triageTaskStatusCategoryV1(transition.state) })) },
      row: { ...base.row, key: id, entryRef: { source: { pluginId: 'happier.triage', localId: 'internal' }, kindId: 'task', collisionScope: 'personal', entryId: id } } });
    const items = [task('a', 'unstarted'), task('b', 'started'), task('c', 'started')];
    const groups = { axis: [assignTriageTaskStatusGroup({ key: 'started', title: 'In progress' }, items,
      { verb: 'Change status', unavailableReason: 'Use the status menu.' })], groupOf: (item: TriageListItemV1) => item.statusGroup };
    const order: PersonalTaskOrder = { scope, undoneOrder: ['a', 'b', 'c'] };
    const a = await renderAnatomy(items[0]!, false, true, order, items, groups.groupOf);
    const b = await renderAnatomy(items[1]!, false, true, order, items, groups.groupOf);
    const c = await renderAnatomy(items[2]!, false, true, order, items, groups.groupOf);
    const resolve = (source: NonNullable<typeof a.source>) => triagePersonalTaskOrderTargetRuntime.resolve({
      item: { kind: 'plugin', scope, contribution: { pluginId: 'happier.triage', localId: 'entry-reference' }, reference: source.reference },
      targetInput: b.target!.input ?? null, destination: null, input: 'pointer',
      parentTargetInput: groups.axis[0]!.membership?.kind === 'assignable' ? groups.axis[0]!.membership.target.input : undefined,
    });
    expect(resolve(a.source!)).toMatchObject({ status: 'allowed', effect: { actionId: 'plugin:happier.triage/tasks/transition-v1', input: { transitionId: 'started' } } });
    expect(resolve(c.source!)).toMatchObject({ status: 'allowed', effect: { actionId: 'tasks.internal.reorder', input: { sourceId: 'c', position: { anchorId: 'b', placement: 'before' } } } });
  });
  it('feeds actual row bindings through the strict target and refuses external or wrong-group tasks', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    const base = entry();
    const task = (id: string, group: TriageListItemV1['group'] = 'unstarted'): TriageListItemV1 => ({ ...base, key: id, group, row: { ...base.row, key: id,
      entryRef: { source: { pluginId: 'happier.triage', localId: 'internal' }, kindId: 'task', collisionScope: 'personal', entryId: id } } });
    const items = [task('a'), task('b'), task('working', 'started')];
    const order: PersonalTaskOrder = { scope, undoneOrder: ['a', 'b', 'working'] };
    const a = await renderAnatomy(items[0]!, false, true, order, items);
    const b = await renderAnatomy(items[1]!, false, true, order, items);
    const resolve = (reference: NonNullable<typeof a.source>['reference'], input: NonNullable<typeof b.target>['input']) => triagePersonalTaskOrderTargetRuntime.resolve({
      item: { kind: 'plugin', scope, contribution: { pluginId: 'happier.triage', localId: 'entry-reference' }, reference },
      targetInput: input ?? null, parentTargetInput: null, destination: null, input: 'pointer',
    });
    expect(resolve(a.source!.reference, b.target!.input)).toMatchObject({ status: 'allowed', effect: {
      actionId: 'tasks.internal.reorder', input: { scope, sourceId: 'a', position: { anchorId: 'b', placement: 'after' } },
    } });
    const qualifiedOwn = { ...items[0]!, row: { ...items[0]!.row, entryRef: { ...items[0]!.row.entryRef, collisionScope: 'account:account' } } };
    const ownRow = await renderAnatomy(qualifiedOwn, false, true, order, [qualifiedOwn, ...items.slice(1)]);
    expect(resolve(ownRow.source!.reference, b.target!.input)).toMatchObject({ status: 'allowed' });
    const external = await renderAnatomy(base, false, true, order, items);
    expect(resolve(external.source!.reference, b.target!.input)).toMatchObject({ status: 'refused', reason: { code: 'task_order_unavailable' } });
    expect(resolve(a.source!.reference, external.target!.input)).toMatchObject({ status: 'refused', reason: { message: 'External tasks keep their source order.' } });
    const working = await renderAnatomy(items[2]!, false, true, order, items);
    expect(resolve(a.source!.reference, working.target!.input)).toMatchObject({ status: 'refused' });
    const shared = { ...items[0]!, row: { ...items[0]!.row, entryRef: { ...items[0]!.row.entryRef, collisionScope: 'account:other' } } };
    const sharedRow = await renderAnatomy(shared, false, true, order, [...items, shared]);
    expect(resolve(sharedRow.source!.reference, b.target!.input)).toMatchObject({ status: 'refused' });
    expect(resolve(a.source!.reference, sharedRow.target!.input)).toMatchObject({ status: 'refused' });
  });
  it('offers the Tasks successor reorder target without replacing the shared row or restoring Zen', async () => {
    const item = entry();
    const task: TriageListItemV1 = { ...item, group: 'unstarted', statusGroup: 'unstarted', row: { ...item.row,
      entryRef: { source: { pluginId: 'happier.triage', localId: 'internal' }, kindId: 'task', collisionScope: 'personal', entryId: 'task-a' } } };
    expect((await renderAnatomy(task, false, true)).target?.targetId).toBe('personal-task-order');
  });
  it('opts into the host-owned native grip only while the list is organizing', async () => {
    expect((await renderAnatomy(entry())).source).toMatchObject({ organizing: false });
    expect((await renderAnatomy(entry(), true)).source).toMatchObject({ organizing: true });
  });

  it('carries the qualified entry and selected source instance, and targets its existing Session link Action', async () => {
    const item = entry();
    const binding = await renderAnatomy(item);
    expect(binding.source).toMatchObject({ sourceId: 'entry-reference', reference: {
      entryRef: item.row.entryRef, title: item.row.title,
      sourceInstance: { source: item.row.entryRef.source, sourceInstanceId: item.row.sourceInstanceId },
      lastKnownLocator: testkitLocator(),
    } });
    expect(binding.target).toMatchObject({ targetId: 'entry-session', input: {
      entryRef: item.row.entryRef,
      display: { locator: testkitLocator(), scopeLabel: item.row.scopeLabel },
    } });
  });

  it('keeps an unread pin as ordinary Collection content rather than promising a current source or link destination', async () => {
    expect(await renderAnatomy(entry(false))).toEqual({ source: null, target: null });
  });
});
