import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import {
  composeWidgetGroupContextV1, createWidgetActionInputResolverV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1,
  resolveWidgetBindingsV1, type WidgetInputBindingsV1, type WidgetLayoutGroupV1,
} from '@happier-dev/protocol/widgets';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import type { WidgetCandidate } from '../widgetCatalog';
import type { WidgetSetupSubmitResult } from '../add/widgetSetupModel';
import { WidgetSetupStep } from '../add/WidgetSetupStep';
import { runWidgetSetupCommand } from '../surface/widgetSurfaceSetup';
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
        basis: { kind: 'context', slot: 'basis' },
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
  expect(project.props.placeholder).toBe('widgetAdd.inheritedValue(value=Example project,source=This page)');
  expect(project.props.value).toBe('');
  const period = screen.findByTestId('edit.field.period.input')!;
  expect(period.props.value).toBe('Today');
  expect(period.props.placeholder ?? '').not.toContain('Yesterday');
  expect(screen.findByTestId('edit.field.basis.control.trigger')?.props.accessibilityLabel).toBe('Cost basis: common.choose');
  await screen.pressByTestIdAsync('edit.submit');
  expect(setInputs).toHaveBeenCalledWith({ period: { kind: 'value', value: 'Today' } });
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
