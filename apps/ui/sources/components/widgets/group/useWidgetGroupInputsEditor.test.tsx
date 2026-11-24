import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { HappierSegmentedChoice } from '@happier-dev/plugin-ui/presentation';
import {
  composeWidgetGroupContextV1, createWidgetActionInputResolverV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1,
  resolveWidgetBindingsV1, type WidgetInputBindingsV1, type WidgetLayoutGroupV1,
} from '@happier-dev/protocol/widgets';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import type { WidgetCandidate } from '../widgetCatalog';
import type { WidgetSetupSubmitResult } from '../add/widgetSetupModel';
import { WidgetSetupStep } from '../add/WidgetSetupStep';
import { runWidgetSetupCommand, type WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import { WidgetSetupPopover } from '../add/WidgetSetupPopover';
import { useWidgetGroupInputsEditor } from './useWidgetGroupInputsEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => standardCleanup());

it('saves one group override while required child inputs keep following the page', async () => {
  const candidate: WidgetCandidate = { key: 'summary', title: 'Summary', pluginName: 'Summary', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition: { kind: 'builtin', id: 'fixture' },
    inputs: { fields: [
      { path: 'filter', title: 'Filter', widget: 'text' },
      { path: 'basis', title: 'Basis', widget: 'text', contextMode: 'follow' },
      { path: 'requiredChildInput', title: 'Required child input', widget: 'text', contextMode: 'follow', required: true },
    ] },
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, basis: { type: 'string', default: 'auto' } } } };
  const setInputs = vi.fn(async (): Promise<WidgetSetupSubmitResult> => ({ ok: true }));
  const hook = await renderHook(() => useWidgetGroupInputsEditor({
    group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
      { kind: 'widget', instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'fixture' }, bindings: {
        filter: { kind: 'context', slot: 'filter' }, basis: { kind: 'context', slot: 'basis' },
        requiredChildInput: { kind: 'context', slot: 'requiredChildInput' },
      } } },
    ] },
    candidates: [candidate], title: 'Group', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
    context: {}, setInputs, testID: 'group',
  }));
  await act(async () => hook.getCurrent().editInputs!.onPress());
  const popover = hook.getCurrent().popover;
  if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
    throw new Error('Missing widget setup popover');
  }
  const screen = await renderScreen(<WidgetSetupStep setup={popover.props.setup()} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  await act(async () => screen.changeTextByTestId('edit.field.filter.input', 'release'));
  await screen.pressByTestIdAsync('edit.submit');
  expect(setInputs).toHaveBeenCalledWith({ filter: { kind: 'value', value: 'release' } });
});

it('saves only the edited Period through either entry point and updates each following child', async () => {
  const surface = { serverId: 'home', accountId: 'actor', owner: {
    kind: 'pluginArea', pluginId: 'fixture', pageId: 'usage', area: 'main',
  } } as const;
  const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
  const store = createWidgetSurfaceArtifactPortV1(boundary.forAccount(surface.accountId), { surface, isCurrent: () => true });
  const definition = { kind: 'builtin', id: 'fixture' } as const;
  const candidate: WidgetCandidate = {
    key: 'summary', title: 'Summary', pluginName: 'Summary', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition,
    inputs: { fields: [
      { path: 'period', title: 'Period', widget: 'text', contextMode: 'follow' },
      { path: 'costBasis', title: 'Cost basis', widget: 'text', contextMode: 'follow' },
    ] },
    inputSchema: { type: 'object', properties: {
      period: { type: 'string' },
      costBasis: { type: 'string', default: 'auto' },
    } },
  };
  const group: WidgetLayoutGroupV1 = {
    kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline',
    children: ['summary', 'daily'].map(id => ({ kind: 'widget', instance: { v: 1, id, definition, bindings: {
      period: { kind: 'context', slot: 'period' }, costBasis: { kind: 'context', slot: 'costBasis' },
    } } })),
  };
  const surfaceContext = { period: ['Last seven days'], costBasis: ['reported'] };
  const executor = createActionExecutor({
    widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
    widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => store) },
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async () => candidate,
      readContext: async () => surfaceContext,
      readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }),
    }),
  });
  await store.apply({ kind: 'group_add', group });
  const write = (bindings: WidgetInputBindingsV1) => executor.execute('widgets.group.inputs.set', {
    ref: { surface, instanceId: group.id }, bindings,
  }, { surface: 'ui', bypassApprovals: true });
  const readGroup = async () => {
    const latest = (await store.read()).items.find(item => item.kind === 'group' && item.id === group.id);
    if (latest?.kind !== 'group') throw new Error('Missing saved group');
    return latest;
  };
  const childInputs = (item: WidgetLayoutGroupV1) => {
    const context = composeWidgetGroupContextV1({ providedContext: surfaceContext, groupBindings: item.context });
    return item.children.map(({ instance }) => resolveWidgetBindingsV1({ instance, fields: candidate.inputs!.fields, context }));
  };
  const ready = (period: string) => ({ status: 'ready', input: { period, costBasis: 'reported' } });
  expect(childInputs(group)).toEqual([ready('Last seven days'), ready('Last seven days')]);

  const periodOnly = { period: { kind: 'value', value: 'Today' } } as const;
  expect(await write(periodOnly)).toMatchObject({ ok: true });
  const typed = await readGroup();
  expect(typed.context).toEqual(periodOnly);
  expect(await write({})).toMatchObject({ ok: true });

  const hook = await renderHook(() => useWidgetGroupInputsEditor({
    group, candidates: [candidate, candidate], title: 'Usage', scope: surface, context: {},
    setInputs: async bindings => {
      const result = await write(bindings);
      if (!result.ok) throw new Error('Group inputs write failed');
      return { ok: true };
    },
    testID: 'group',
  }));
  await act(async () => hook.getCurrent().editInputs!.onPress());
  const popover = hook.getCurrent().popover;
  if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
    throw new Error('Missing widget setup popover');
  }
  const screen = await renderScreen(<WidgetSetupStep setup={popover.props.setup()} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  await act(async () => screen.changeTextByTestId('edit.field.period.input', 'Today'));
  await screen.pressByTestIdAsync('edit.submit');

  const edited = await readGroup();
  expect(edited.context).toEqual(typed.context);
  expect(childInputs(edited)).toEqual([ready('Today'), ready('Today')]);
});

it('shows inherited values as placeholders without setting group overrides', async () => {
  const definition = { kind: 'builtin', id: 'fixture' } as const;
  const candidate: WidgetCandidate = {
    key: 'summary', title: 'Summary', pluginName: 'Summary', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition,
    inputs: { fields: [
      { path: 'project', title: 'Project', widget: 'text', contextMode: 'follow' },
      { path: 'period', title: 'Period', widget: 'text', contextMode: 'follow' },
      { path: 'basis', title: 'Cost basis', widget: 'select', options: [{ value: 'reported', label: 'Reported' }] },
    ] },
  };
  const setInputs = vi.fn(async (): Promise<WidgetSetupSubmitResult> => ({ ok: true }));
  const hook = await renderHook(() => useWidgetGroupInputsEditor({
    group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline',
      context: { period: { kind: 'value', value: 'Today' } },
      children: [{ kind: 'widget', instance: { v: 1, id: 'summary', definition, bindings: {
        project: { kind: 'context', slot: 'project' }, period: { kind: 'context', slot: 'period' },
      } } }],
    },
    candidates: [candidate], title: 'Usage', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
    context: { slots: {
      project: { label: 'This page', value: { value: 'example', label: 'Example project' } },
      period: { label: 'This page', value: { value: 'Yesterday', label: 'Yesterday' } },
    } },
    testID: 'group', setInputs,
  }));
  await act(async () => hook.getCurrent().editInputs!.onPress());
  const popover = hook.getCurrent().popover;
  if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
    throw new Error('Missing widget setup popover');
  }
  const screen = await renderScreen(<WidgetSetupStep setup={popover.props.setup()} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  const project = screen.findByTestId('edit.field.project.input')!;
  expect(project.props.placeholder).toBe('widgetAdd.inheritedValue(value=Example project,source=widgetFrame.followingGroup)');
  expect(project.props.value).toBe('');
  const period = screen.findByTestId('edit.field.period.input')!;
  expect(period.props.value).toBe('Today');
  expect(period.props.placeholder ?? '').not.toContain('Yesterday');
  expect(screen.findByTestId('edit.field.basis.control.trigger')?.props.accessibilityLabel).toBe('Cost basis: common.choose');
  await screen.pressByTestIdAsync('edit.submit');
  expect(setInputs).toHaveBeenCalledWith({ period: { kind: 'value', value: 'Today' } });
});

describe('group inherited readings', () => {
  const definition = { kind: 'builtin', id: 'fixture' } as const;
  const candidate: WidgetCandidate = {
    key: 'summary', title: 'Summary', pluginName: 'Usage', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition,
    inputs: { fields: [
      { path: 'period', title: 'Period', widget: 'text', contextMode: 'follow' },
      { path: 'calendar', title: 'Calendar', widget: 'text', contextMode: 'follow' },
      { path: 'count', title: 'Count', widget: 'integer', contextMode: 'follow' },
      { path: 'retryLimit', title: 'Retry limit', widget: 'integer', contextMode: 'follow' },
      { path: 'retrySetting', title: 'Retry setting', widget: 'integer', contextMode: 'follow' },
      { path: 'priority', title: 'Priority', widget: 'select',
        options: [{ value: 2, label: 'High' }] },
      { path: 'route', title: 'Route', widget: 'text', contextMode: 'follow' },
      { path: 'unknownChoice', title: 'Unknown choice', widget: 'select', contextMode: 'follow',
        options: [{ value: 'listed', label: 'Listed' }] },
      { path: 'projects', title: 'Projects', widget: 'multiselect', contextMode: 'follow',
        options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] },
      { path: 'basis', title: 'Cost basis', widget: 'select', contextMode: 'follow',
        options: [{ value: 'auto', label: 'Automatic' }, { value: 'reported', label: 'Reported' }] },
    ] },
    inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
  };
  const slots = {
    period: { label: 'This page', value: { value: 'Today', label: 'Today' } },
    calendar: { label: 'This calendar', value: { value: 'Yesterday', label: 'Yesterday' } },
    otherCalendar: { label: 'Other calendar', value: { value: 'Yesterday', label: 'Yesterday' } },
    basis: { label: 'This page', value: { value: 'auto', label: 'Default cost basis' } },
    projects: { label: 'This page', value: { value: [], label: 'All projects' } },
    work: { label: 'This project area', value: { value: ['one', 'two'], label: '2 projects' } },
    retrySetting: { label: 'This page', value: { value: 1, label: '1' } },
    periodAlias: { label: 'This page', value: { value: 'shared', label: 'Period option' } },
    calendarAlias: { label: 'This page', value: { value: 'shared', label: 'Calendar option' } },
    route: { label: 'This page', value: { value: 'listed', label: 'Listed' } },
  } satisfies NonNullable<WidgetSurfaceContext['slots']>;
  const follow = (slot: string) => ({ kind: 'context', slot } as const);
  const pin = (value: string | number) => ({ kind: 'value', value } as const);
  const inherited = (value: string) => `widgetAdd.inheritedValue(value=${value},source=widgetFrame.followingGroup)`;

  const mount = async (children: readonly WidgetInputBindingsV1[], bindings: WidgetInputBindingsV1 = {}) => {
    const setInputs = vi.fn(async (): Promise<WidgetSetupSubmitResult> => ({ ok: true }));
    const hook = await renderHook(() => useWidgetGroupInputsEditor({
      group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline',
        context: bindings, children: children.map((child, index) => ({
          kind: 'widget', instance: { v: 1, id: `child-${index}`, definition, bindings: child },
        })) },
      candidates: children.map(() => candidate), title: 'Usage',
      scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
      context: { slots }, testID: 'group', setInputs,
    }));
    await act(async () => hook.getCurrent().editInputs!.onPress());
    const popover = hook.getCurrent().popover;
    if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
      throw new Error('Missing widget setup popover');
    }
    const screen = await renderScreen(<WidgetSetupStep setup={popover.props.setup()} phone={false} testID="edit"
      onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
    return { screen, setInputs };
  };

  it('shows the same-slot inherited reading under the short choice and saves no overrides', async () => {
    const { screen, setInputs } = await mount([{ basis: follow('basis') }]);
    expect(screen.getTextContent()).toContain(inherited('Automatic'));
    const control = screen.findByType(HappierSegmentedChoice);
    expect(control.props.segments.map((segment: { selected: boolean }) => segment.selected)).toEqual([false, false]);
    await screen.pressByTestIdAsync('edit.submit');
    expect(setInputs).toHaveBeenCalledWith({});
  });

  it('names a draft retry limit with its number even when Priority uses the same number', async () => {
    const { screen, setInputs } = await mount([{ retryLimit: follow('retrySetting') }], { priority: pin(2) });
    const reading = () => screen.findByTestId('edit.field.retryLimit.input')?.props.placeholder;
    expect(reading()).toBe(inherited('1'));
    await act(async () => screen.changeTextByTestId('edit.field.retrySetting.input', '2'));
    expect(reading()).toBe(inherited('2'));
    await screen.pressByTestIdAsync('edit.submit');
    expect(setInputs).toHaveBeenCalledWith({ priority: pin(2), retrySetting: pin(2) });
  });

  it('keeps the two bound slot labels when their raw string values are equal', async () => {
    const { screen } = await mount([{ period: follow('periodAlias'), calendar: follow('route') }], { route: follow('calendarAlias') });
    expect(screen.findByTestId('edit.field.period.input')?.props.placeholder).toBe(inherited('Period option'));
    expect(screen.findByTestId('edit.field.calendar.input')?.props.placeholder).toBe(inherited('Calendar option'));
  });

  it('labels a group pin with the child declaration that follows it', async () => {
    const { screen } = await mount([{ period: follow('priority') }], { priority: pin(2) });
    expect(screen.findByTestId('edit.field.period.input')?.props.placeholder).toBe(inherited('2'));
  });

  it('leaves a choice unnamed when its bound draft input has no applicable label', async () => {
    const { screen } = await mount([{ unknownChoice: follow('route') }]);
    const reading = () => screen.findByTestId('edit.field.unknownChoice.control.trigger')?.props.accessibilityLabel;
    expect(reading()).toBe(`Unknown choice: ${inherited('Listed')}`);
    await act(async () => screen.changeTextByTestId('edit.field.route.input', 'opaque'));
    expect(reading()).toBe(`Unknown choice: ${inherited('Unknown choice')}`);
  });

  it.each([
    ['uses the child’s declared slot', [{ period: follow('calendar') }], inherited('Yesterday')],
    ['agrees when two children use the same slot', [{ period: follow('calendar') }, { period: follow('calendar') }], inherited('Yesterday')],
    ['ignores a pinned child while showing what the following child reads', [{ period: pin('Monday') }, { period: follow('calendar') }], inherited('Yesterday')],
    ['names competing child contexts without identifying a value', [{ period: follow('period') }, { period: follow('calendar') }], inherited('widgetAdd.severalValues')],
    ['makes no claim when a child is unresolved even if other children disagree', [{ period: follow('period') }, { period: follow('missing') }, { period: follow('calendar') }], inherited('Period')],
    ['leaves an incomplete inherited reading empty', [{ period: follow('period') }, { period: follow('missing') }], inherited('Period')],
    ['makes no claim when the followed slot has nothing to inherit', [{ period: follow('missing') }], inherited('Period')],
  ] as const)('%s', async (_name, children, expected) => {
    const { screen } = await mount(children);
    const input = screen.findByTestId('edit.field.period.input')!;
    expect(input.props.value).toBe('');
    expect(input.props.placeholder).toBe(expected);
  });

  it.each([['calendar', 'otherCalendar'], ['otherCalendar', 'calendar']])('uses one attribution with slots %s and %s', async (a, b) => {
    const { screen } = await mount([{ period: follow(a) }, { period: follow(b) }]);
    expect(screen.findByTestId('edit.field.period.input')?.props.placeholder).toBe(inherited('Yesterday'));
  });

  it('updates the inherited Period when Calendar is pinned in the same draft', async () => {
    const { screen, setInputs } = await mount([{ period: follow('calendar'), calendar: follow('calendar') }]);
    const reading = () => screen.findByTestId('edit.field.period.input')?.props.placeholder;
    expect(reading()).toContain('Yesterday');
    await act(async () => screen.changeTextByTestId('edit.field.calendar.input', 'Today'));
    expect(reading()).toBe(inherited('Today'));
    await screen.pressByTestIdAsync('edit.submit');
    expect(setInputs).toHaveBeenCalledWith({ calendar: pin('Today') });
  });

  it('does not name a text value the numeric child rejects', async () => {
    const { screen } = await mount([{ count: follow('calendar') }]);
    expect(screen.findByTestId('edit.field.count.input')?.props.placeholder).toBe(inherited('Count'));
  });

  it('uses the one inherited list to read a count of two Projects in a popup field', async () => {
    const { screen } = await mount([{ projects: follow('work') }]);
    expect(screen.findByTestId('edit.field.projects.control.trigger')?.props.accessibilityLabel)
      .toBe(`Projects: ${inherited('2 projects')}`);
  });

  it('shows a set short choice as selected radios with no inherited claim', async () => {
    const { screen } = await mount([{ basis: follow('basis') }], { basis: pin('reported') });
    const control = screen.findByType(HappierSegmentedChoice);
    expect(control.props.segments.map((segment: { selected: boolean }) => segment.selected)).toEqual([false, true]);
    expect(screen.getTextContent()).not.toContain('widgetAdd.inheritedValue');
  });
});

it('names the child whose effective inputs reject the group edit', async () => {
  const summary = { kind: 'builtin', id: 'summary' } as const;
  const daily = { kind: 'builtin', id: 'daily' } as const;
  const candidate: WidgetCandidate = {
    key: 'summary', title: 'Summary', pluginName: 'Usage', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition: summary,
    inputs: { fields: [{ path: 'period', title: 'Period', widget: 'text', contextMode: 'follow' }] },
    inputSchema: { type: 'object', properties: { period: { type: 'string' } } },
  };
  // The save port reports the actual child that refused the group write.
  const write = vi.fn(async (bindings: WidgetInputBindingsV1) => {
    if (bindings.period?.kind === 'value' && bindings.period.value === 'Yesterday') {
      throw Object.assign(new Error('widget_inputs_invalid'), { code: 'widget_inputs_invalid', details: { blockingChildId: 'daily' } });
    }
  });
  const setInputs = (bindings: WidgetInputBindingsV1) => runWidgetSetupCommand(() => write(bindings), 'Save failed');
  const hook = await renderHook(() => useWidgetGroupInputsEditor({
    group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline',
      children: [summary, daily].map(definition => ({ kind: 'widget', instance: {
        v: 1, id: definition.id, definition, bindings: { period: { kind: 'context', slot: 'period' } },
        ...(definition === daily ? { displayName: 'Release activity' } : {}),
      } })),
    },
    candidates: [candidate, { ...candidate, key: 'daily', title: 'Daily usage', definition: daily,
      inputSchema: candidate.inputSchema,
    }],
    title: 'Usage', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } },
    context: { slots: { period: { label: 'This page', value: { value: 'Today', label: 'Today' } } } },
    testID: 'group', setInputs,
  }));
  await act(async () => hook.getCurrent().editInputs!.onPress());
  const popover = hook.getCurrent().popover;
  if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
    throw new Error('Missing widget setup popover');
  }
  const screen = await renderScreen(<WidgetSetupStep setup={popover.props.setup()} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  await act(async () => screen.changeTextByTestId('edit.field.period.input', 'Yesterday'));
  await screen.pressByTestIdAsync('edit.submit');
  expect(screen.getTextContent()).toContain('widgetAdd.groupChildInputsInvalid(widget=Release activity)');
  expect(write).toHaveBeenLastCalledWith({ period: { kind: 'value', value: 'Yesterday' } });

  await act(async () => screen.changeTextByTestId('edit.field.period.input', 'Today'));
  await screen.pressByTestIdAsync('edit.submit');
  expect(write).toHaveBeenLastCalledWith({ period: { kind: 'value', value: 'Today' } });
});

it.each(['pending', 'refused', 'applied'] as const)('keeps the typed %s acknowledgement and the entered draft until an applied edit', async kind => {
  const candidate: WidgetCandidate = { key: 'checks', title: 'Checks', pluginName: 'Checks', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition: { kind: 'builtin', id: 'fixture' },
    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text' }] } };
  const setInputs = vi.fn(async (): Promise<WidgetSetupSubmitResult> => kind === 'refused' ? { ok: false, message: 'Refused' }
    : { ok: true, ...(kind === 'pending' ? { approvalPending: true as const } : {}) });
  const hook = await renderHook(() => useWidgetGroupInputsEditor({
    group: { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline', context: {}, children: [
      { kind: 'widget', instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'fixture' }, bindings: { filter: { kind: 'context', slot: 'filter' } } } },
    ] },
    candidates: [candidate], title: 'Group', scope: { serverId: 'home', accountId: 'actor', owner: { kind: 'home' } }, context: {}, setInputs, testID: 'group',
  }));
  await act(async () => hook.getCurrent().editInputs!.onPress());
  const popover = hook.getCurrent().popover!;
  if (!React.isValidElement<React.ComponentProps<typeof WidgetSetupPopover>>(popover) || popover.type !== WidgetSetupPopover) {
    throw new Error('Missing widget setup popover');
  }
  const setup = popover.props.setup();
  const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  await act(async () => screen.changeTextByTestId('edit.field.filter.input', 'release'));
  await screen.pressByTestIdAsync('edit.submit');
  expect(setInputs).toHaveBeenCalledWith({ filter: { kind: 'value', value: 'release' } });
  if (kind === 'applied') expect(hook.getCurrent().popover).toBeNull();
  else {
    expect(hook.getCurrent().popover).not.toBeNull();
    expect(screen.findByTestId('edit.field.filter.input')!.props.value).toBe('release');
    let outcome: WidgetSetupSubmitResult | undefined;
    await act(async () => { outcome = await setup.submit({ bindings: {} }); });
    expect(outcome).toEqual(kind === 'pending' ? { ok: true, approvalPending: true } : { ok: false, message: 'Refused' });
  }
});
