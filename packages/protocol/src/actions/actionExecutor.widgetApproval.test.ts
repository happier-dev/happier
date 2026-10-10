import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import type { ActionId } from './actionIds.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import type { WidgetSurfaceRefV1 } from '../widgets/widgetInstanceV1.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { createWidgetAreaActionPortV1, createWidgetAreaLayoutArtifactPortV1, createWidgetSurfaceArtifactPortV1 } from '../widgets/widgetSurfaceArtifactV1.js';

const account = { serverId: 'home', accountId: 'account' };

async function fixture(owner: WidgetSurfaceRefV1['owner'], shared: boolean) {
  const boundary = createWorkBoardArtifactBoundary();
  const transport = boundary.forAccount(account.accountId);
  // Artifact transport is the system boundary; domain ports and approval logic remain real.
  const admittedTransport = { ...transport, delete: boundary.transport.delete,
    read: async (...args: Parameters<typeof transport.read>) => {
      const row = await transport.read(...args);
      return row ? { ...row, shared } : null;
    },
    list: async (...args: Parameters<typeof boundary.transport.list>) => {
      const page = await boundary.transport.list(...args);
      return { ...page, items: page.items.map(row => ({ ...row, bodyVersion: boundary.rows.get(row.artifactId)!.revision.bodyVersion })) };
    },
  };
  const surface: WidgetSurfaceRefV1 = { ...account, owner };
  const presets = [{ id: 'main', name: 'Main', items: [] }, { id: 'other', name: 'Other', items: [] }];
  const artifactFor = (target: WidgetSurfaceRefV1) => createWidgetSurfaceArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const layoutsFor = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const artifact = artifactFor(surface);
  for (const id of ['one', 'two']) await artifact.apply({ kind: 'add', instance: {
    v: 1, id, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {},
  }, size: 'small' });
  await artifact.apply({ kind: 'group_create', groupId: 'group', instanceIds: ['two'] });
  const port = createWidgetAreaActionPortV1(artifactFor);
  const executor = createActionExecutor({ widgetAccountScope: () => account,
    widgetSurfaceActions: { [owner.kind]: port },
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async ({ instance }) => readBuiltinWidgetDescriptorV1(instance.definition),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    }),
    widgetAreaLayouts: {
      reset: (input, _context, signal) => artifactFor(input.surface).resetPreset(input.expectedRevision, signal),
      undo: (capture, _context, signal) => artifactFor(capture.surface).undoReset(capture, signal),
      list: (input, _context, signal) => layoutsFor(input.surface).list(signal),
      create: (input, _context, signal) => layoutsFor(input.surface).create(input, signal),
      rename: (input, _context, signal) => layoutsFor(input.surface).rename(input, signal),
      reorder: (input, _context, signal) => layoutsFor(input.surface).reorder(input, signal),
      delete: (input, _context, signal) => layoutsFor(input.surface).delete(input, signal),
    },
  });
  return { surface, artifact, layouts: layoutsFor(surface), executor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function revision(artifact: Fixture['artifact']) {
  const state = await artifact.readState();
  if (state.kind !== 'present') throw new Error('Expected seeded layout');
  return state.revision;
}
const edits: readonly { name: string; action: ActionId; input: (state: Fixture) => Promise<unknown> | unknown }[] = [
  { name: 'widget rename', action: 'widgets.item.rename', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, displayName: 'Renamed' }) },
  { name: 'widget size', action: 'widgets.item.size.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, size: 'medium' }) },
  { name: 'widget frame', action: 'widgets.item.frame.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, frameStyle: 'plain' }) },
  { name: 'widget reorder', action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, toIndex: 1 }) },
  { name: 'widget native reorder', action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, to: { surface, index: 1 } }) },
  { name: 'group width', action: 'widgets.item.size.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, width: 'half' }) },
  { name: 'group dividers', action: 'widgets.group.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, dividers: 'none' }) },
  { name: 'layout create', action: 'widgets.area.layout.create', input: ({ surface }) => ({ surface, layoutId: 'new', name: 'New' }) },
  { name: 'layout rename', action: 'widgets.area.layout.rename', input: async ({ surface, artifact }) => ({ surface, name: 'Renamed', expectedRevision: await revision(artifact) }) },
  { name: 'layout reorder', action: 'widgets.area.layout.reorder', input: async ({ surface, artifact, layouts }) => ({ surface,
    expectedRevision: await revision(artifact), position: { anchorId: (await layouts.list()).find(row => row.surface.owner.kind === surface.owner.kind && 'layoutId' in row.surface.owner && row.surface.owner.layoutId === 'other')!.artifactId, placement: 'after' } }) },
  { name: 'layout reset', action: 'widgets.area.layout.reset', input: async ({ surface, artifact }) => ({ surface, expectedRevision: await revision(artifact) }) },
  { name: 'layout undo', action: 'widgets.area.layout.undo', input: async ({ artifact }) => {
    const reset = await artifact.resetPreset(await revision(artifact));
    return { capture: reset.undo };
  } },
];

const owners = [
  { name: 'private Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: true, dangerous: true },
  { name: 'plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: true, dangerous: true },
  { name: 'core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: true, dangerous: true },
] as const;

const consequentialEdits: readonly { action: ActionId; input: (state: Fixture) => unknown }[] = [
  { action: 'widgets.item.remove', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.item.add', input: ({ surface }) => ({ surface, instance: { v: 1, id: 'added', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }) },
  { action: 'widgets.item.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, bindings: {} }) },
  { action: 'widgets.item.inputs.reset', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.group.create', input: ({ surface }) => ({ surface, groupId: 'another-group', instanceIds: ['one'] }) },
  { action: 'widgets.group.ungroup', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' } }) },
  { action: 'widgets.group.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, bindings: {} }) },
  { action: 'widgets.group.add', input: ({ surface }) => ({ surface, group: { kind: 'group', id: 'copied-group', width: 'full',
    frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: { v: 1, id: 'copied-child', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] } }) },
  { action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' },
    to: { surface: { ...surface, owner: { ...surface.owner, layoutId: 'other' } }, index: 0 } }) },
];

describe('contextual widget approval at the Action executor', () => {
  it.each(owners.flatMap(owner => edits.map(edit => ({ ...owner, ...edit }))))('$name ($owner.kind, shared=$shared)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const before = [...(await state.artifact.read()).items];
    const result = await state.executor.execute(row.action, input, { surface: 'mcp', authority: 'account_automation' });
    // Projects are linear: safe approval classification must still reach the real size refusal.
    const expected = row.dangerous ? { ok: false, errorCode: 'approvals_not_supported' }
      : row.name === 'widget size' && row.owner.kind === 'project' ? { ok: false, errorCode: 'widget_size_unsupported' }
      : { ok: true };
    expect(result, JSON.stringify(result)).toMatchObject(expected);
    if (row.dangerous) expect((await state.artifact.read()).items).toEqual(before);
  });

  it.each(owners.filter(owner => !owner.dangerous).flatMap(owner => edits.map(edit => ({ ...owner, ...edit }))))('retains explicit Ask-first for $name ($owner.kind)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: { [row.action]: { approvalRequiredSurfaces: ['mcp'] } } });
    expect(await state.executor.execute(row.action, input, { surface: 'mcp', authority: 'account_automation', actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it.each(owners)('retains destructive layout deletion for $name', async row => {
    const state = await fixture(row.owner, row.shared);
    const created = await state.layouts.create({ surface: state.surface, layoutId: 'delete-me', name: 'Delete me' });
    expect(await state.executor.execute('widgets.area.layout.delete', { surface: created.surface, expectedRevision: created.revision },
      { surface: 'mcp', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it.each(owners.flatMap(owner => consequentialEdits.map(edit => ({ ...owner, ...edit }))))('retains danger for $action on $name', async row => {
    const state = await fixture(row.owner, row.shared);
    expect(await state.executor.execute(row.action, row.input(state), { surface: 'mcp', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });
});
