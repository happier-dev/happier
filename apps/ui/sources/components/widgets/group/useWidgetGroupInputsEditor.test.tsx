import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { WidgetCandidate } from '../widgetCatalog';
import type { WidgetSetupSubmitResult } from '../add/widgetSetupModel';
import { WidgetSetupStep } from '../add/WidgetSetupStep';
import { useWidgetGroupInputsEditor } from './useWidgetGroupInputsEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => standardCleanup());

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
  const setup = popover.props.setup();
  const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} testID="edit" onDone={popover.props.onDone ?? popover.props.onRequestClose} />);
  await act(async () => screen.changeTextByTestId('edit.field.filter.input', 'release'));
  await screen.pressByTestIdAsync('edit.submit');
  expect(setInputs).toHaveBeenCalledWith({ filter: { kind: 'value', value: 'release' } });
  if (kind === 'applied') expect(hook.getCurrent().popover).toBeNull();
  else {
    expect(hook.getCurrent().popover).not.toBeNull();
    expect(screen.findByTestId('edit.field.filter.input')!.props.value).toBe('release');
    expect(await setup.submit({ bindings: {} })).toEqual(kind === 'pending' ? { ok: true, approvalPending: true } : { ok: false, message: 'Refused' });
  }
});
