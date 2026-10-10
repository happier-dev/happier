import { describe, expect, it, vi } from 'vitest';
import type {
  WidgetInstanceV1,
  WidgetLayoutGroupV1,
  WidgetLayoutItemV1,
} from '@happier-dev/protocol/widgets';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, getWidgetLayoutItemIdV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { buildHomeHubArtifactIdV1, createHomeHubArtifactPortV1, HOME_HUB_ARTIFACT_KIND_V1, resolveHomeHubLayout } from '@happier-dev/protocol/home';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useHomeWidgetGroupOperations } from '@/components/hub/layout/useHomeWidgetGroupOperations';
import type { HomeHubLayout } from '@/components/hub/layout/useHomeHubLayout';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
// Menu presentation reads ambient app settings; mutation policy and persistence
// below use the real executor and Artifact owners, independent of this boundary.
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

const { buildWidgetGroupActions, buildWidgetGroupMembershipActions } =
  await import('./widgetGroupMenu');

const instance = (id: string): WidgetInstanceV1 => ({
  v: 1,
  id,
  definition: {
    kind: 'installed',
    surface: { pluginId: 'acme.ci', localId: 'checks' },
  },
  bindings: {},
});
const group = (
  id: string,
  width: 'half' | 'full',
  sizes: Array<['small' | 'wide', string]>,
): WidgetLayoutGroupV1 => ({
  kind: 'group',
  id,
  width,
  frameStyle: 'card',
  dividers: 'hairline',
  children: sizes.map(([size, childId]) => ({
    kind: 'widget' as const,
    instance: instance(childId),
    size,
  })),
});
const operations = () => ({
  setWidth: vi.fn(),
  setFrame: vi.fn(),
  setDividers: vi.fn(),
  ungroup: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
  create: vi.fn(),
});
const title = (id: string) => id;

describe('buildWidgetGroupActions', () => {
  it('keeps a width the widgets cannot fit visible but unavailable, naming the widget that prevents it', () => {
    const ops = operations();
    const actions = buildWidgetGroupActions({
      group: group('g', 'full', [
        ['wide', 'daily'],
        ['small', 'summary'],
      ]),
      childTitle: title,
      operations: ops,
      showWidth: true,
      editInputs: undefined, onRename: undefined, onSave: undefined, onAddTo: undefined,
    });
    const half = actions.find((action) => action.id === 'width-half')!;
    expect(half.disabled).toBe(true);
    expect(half.subtitle).toContain('daily');
    expect(actions.find((action) => action.id === 'width-full')!.selected).toBe(
      true,
    );
    // Ungroup keeps the widgets; removing the widgets too is its own, last, destructive entry.
    expect(actions.at(-1)).toMatchObject({
      id: 'removeGroup',
      destructive: true,
    });
    actions.find((action) => action.id === 'ungroup')!.onPress!();
    expect(ops.ungroup).toHaveBeenCalledWith('g');
    expect(ops.remove).not.toHaveBeenCalled();
  });

  it('offers no width on a phone, where everything is full width', () => {
    const actions = buildWidgetGroupActions({
      group: group('g', 'half', [['small', 'a']]),
      childTitle: title,
      operations: operations(),
      showWidth: true,
      geometry: { phone: true, columns: 1 },
      editInputs: undefined, onRename: undefined, onSave: undefined, onAddTo: undefined,
    });
    expect(actions.some((action) => action.id.startsWith('width-'))).toBe(
      false,
    );
    expect(actions.some(action => action.id.startsWith('frame-'))).toBe(true);
    expect(actions.some(action => action.id.startsWith('dividers-'))).toBe(true);
  });
});

describe('buildWidgetGroupMembershipActions', () => {
  it.each((['home', 'project-main', 'project-aside', 'pluginArea', 'corePage'] as const).flatMap(host =>
    [false, true].map(singleton => ({ host, singleton }))))('persists removal beside its group on $host (singleton=$singleton)', async ({ host, singleton }) => {
      const scope = { serverId: 'home', accountId: 'account' };
      const area = host === 'project-main' ? 'main' as const : host === 'project-aside' ? 'aside' as const : undefined;
      const surface: WidgetSurfaceRefV1 = { ...scope, owner: host === 'home' ? { kind: 'home' }
        : area ? { kind: 'project', projectId: 'project', layoutId: 'ordering' }
          : host === 'pluginArea' ? { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'main' }
            : { kind: 'corePage', pageId: 'usage', area: 'main' } };
      const child = { kind: 'widget' as const, instance: instance('moving'), size: 'small' as const, frameStyle: 'plain' as const };
      const source = { ...group('source', 'full', [['small', 'remaining']]), children: singleton ? [child] : [child, { kind: 'widget' as const, instance: instance('remaining'), size: 'small' as const }], ...(area ? { area } : {}) };
      const items: WidgetLayoutItemV1[] = [source, { kind: 'widget', instance: instance('next'), size: 'small', ...(area ? { area } : {}) }];
      // Project phone combines both areas into one rendered list. The movement owner
      // still interprets its index within the extracted child's own area.
      if (area) items.unshift({ kind: 'widget', instance: instance('other-area'), size: 'small', area: area === 'main' ? 'aside' : 'main' });
      const builtins = [{ id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'usage', hideable: true, afterWidgets: true }];
      const prefix = ['start', 'attention', 'retained-a', 'retained-b'];
      const homeLayout = { v: 1 as const, order: [...prefix, 'source', 'next', 'usage'], hidden: [], items };
      const boundary = createWorkBoardArtifactBoundary();
      const isHome = host === 'home';
      const artifactId = isHome ? buildHomeHubArtifactIdV1(scope.accountId) : buildWidgetSurfaceArtifactIdV1(surface);
      const areaLayout = { v: 1 as const, surface, items };
      boundary.rows.set(artifactId, { artifactId, header: isHome ? { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' } : buildWidgetSurfaceArtifactHeaderV1(areaLayout),
        body: JSON.stringify(isHome ? homeLayout : areaLayout), revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner' });
      const transport = boundary.forAccount(scope.accountId);
      const homeOwner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId, builtins });
      const areaOwner = isHome ? null : createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
      const areaPort = areaOwner ? createWidgetAreaActionPortV1(() => areaOwner) : undefined;
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
        ...(isHome ? { homeHubArtifacts: homeOwner } : { widgetSurfaceActions: { project: areaPort, pluginArea: areaPort, corePage: areaPort } }) }));
      let pending: ReturnType<typeof executor.execute> | undefined;
      const ops = operations();
      ops.move.mockImplementation((instanceId: string, toIndex: number, groupId: string | null) => {
        pending = executor.execute('widgets.item.move', { ref: { surface, instanceId }, to: { surface, index: toIndex, groupId, ...(area ? { area } : {}) } }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] } }),
        });
      });
      const moveHome = (intent: Parameters<HomeHubLayout['moveTo']>[1] | undefined, instanceId: string, toIndex?: number, groupId?: string | null): Promise<void> => {
        pending = executor.execute('home.hub.layout.update', { intent: intent ? { kind: 'move_to', sectionId: instanceId, position: intent }
          : { kind: 'move', instanceId, toIndex, groupId } }, { surface: 'ui' });
        return pending.then(result => { if (!result.ok) throw new Error(result.errorCode); });
      };
      const homeOperations: Pick<HomeHubLayout, 'setGroup' | 'setFrameStyle' | 'ungroup' | 'remove' | 'createGroup' | 'moveItem' | 'moveTo'> = {
        setGroup: async () => {}, setFrameStyle: async () => {}, ungroup: async () => {}, remove: async () => {}, createGroup: async () => {},
        moveItem: (id, index, groupId) => moveHome(undefined, id, index, groupId),
        moveTo: (id, position) => moveHome(position, id),
      };
      const hook = isHome ? await renderHook(() => useHomeWidgetGroupOperations(homeOperations)) : null;
      const input = { instanceId: 'moving', size: 'small' as const, items, area, childTitle: title, operations: hook?.getCurrent() ?? ops,
        ...(isHome ? { topLevelIds: resolveHomeHubLayout(homeLayout, builtins, []).order } : {}) };
      const menu = buildWidgetGroupMembershipActions(input);
      menu.find(action => action.id === 'removeFromGroup')!.onPress!();
      expect(pending).toBeDefined();
      expect(await pending).toMatchObject({ ok: true });
      const committed = isHome ? await homeOwner.read() : await areaOwner!.read();
      const itemIds = committed.items.filter(item => !area || item.area === area).map(getWidgetLayoutItemIdV1);
      const order = isHome ? (await homeOwner.read()).order.filter(id => itemIds.includes(id)) : itemIds;
      expect(order).toEqual(singleton ? ['moving', 'next'] : ['source', 'moving', 'next']);
      expect(committed.items.find(item => item.kind === 'widget' && item.instance.id === 'moving')).toEqual({ ...child, ...(area ? { area } : {}) });
      if (isHome) expect((await homeOwner.read()).order).toEqual([...prefix, ...(singleton ? [] : ['source']), 'moving', 'next', 'usage']);
      if (area) expect(committed.items.filter(item => item.area !== area)).toEqual([items[0]]);
      await hook?.unmount();
  });
  const items: WidgetLayoutItemV1[] = [
    { kind: 'widget', instance: instance('lone'), size: 'small' },
    group('half-group', 'half', [['small', 'checks']]),
    { kind: 'widget', instance: instance('daily'), size: 'wide' },
    group('full-group', 'full', [
      ['small', 'prs'],
      ['small', 'services'],
    ]),
  ];

  it('places a widget removed from its group beside the group, back on its own card', () => {
    const ops = operations();
    const actions = buildWidgetGroupMembershipActions({
      instanceId: 'prs',
      size: 'small',
      items,
      childTitle: title,
      operations: ops,
    });
    expect(actions.map((action) => action.id)).toEqual([
      'moveToGroup-half-group',
      'removeFromGroup',
      'ungroup',
    ]);
    actions.find((action) => action.id === 'removeFromGroup')!.onPress!();
    expect(ops.move).toHaveBeenCalledWith('prs', 4, null);
  });

  it('groups a standalone widget with a neighbour, and refuses a group too narrow for it with the reason', () => {
    const ops = operations();
    const actions = buildWidgetGroupMembershipActions({
      instanceId: 'daily',
      size: 'wide',
      items,
      childTitle: title,
      operations: ops,
    });
    expect(
      actions.find((action) => action.id === 'groupWith-half-group'),
    ).toMatchObject({ disabled: true });
    expect(
      actions.find((action) => action.id === 'groupWith-full-group')?.disabled,
    ).toBeUndefined();
    actions.find((action) => action.id === 'groupWith-full-group')!.onPress!();
    expect(ops.move).toHaveBeenCalledWith('daily', 2, 'full-group');
    // Its standalone neighbours make a new untitled group, in reading order.
    expect(
      actions.some((action) => action.id.startsWith('groupWith-lone')),
    ).toBe(false);
  });
});
