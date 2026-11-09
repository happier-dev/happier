import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { InputHints } from '@happier-dev/protocol/inputs';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { isWidgetFollowingSurfaceSlot, useWidgetInstanceBindingLabel } from './useWidgetInstanceBindingLabel';
import { useWidgetBindingValueLabels } from './useWidgetBindingValueLabels';
import { describeWidgetGroupContext, readWidgetGroupFollowedValue, widgetGroupSurfaceContext } from '../group/widgetGroupInputs';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));

afterEach(() => standardCleanup());

it('redacts private Session pin labels on sharing push without changing the binding and restores them', async () => {
  const previous = storage.getState();
  const session = createSessionFixture({ id: 'private-pin', serverId: 'home', metadata: { name: 'Secret invoices', path: '/private', host: 'host' } });
  const bindings = { selected: { kind: 'value' as const, value: { serverId: 'home', sessionId: session.id } } };
  storage.setState({ sessions: { [session.id]: session }, settings: { ...previous.settings,
    sessionListHiddenTagIdsWhileRecording: { home: ['secret'] } }, sessionOrganizationTagAssignmentsBySessionKey: {
      [buildSessionOrganizationSessionKey('home', session.id)]: { sessionId: session.id, tagIds: ['secret'] },
    } });
  const hook = await renderHook(() => useWidgetBindingValueLabels(bindings, { sessionInputPath: 'selected' }));
  try {
    expect(hook.getCurrent().selected).toBe('Secret invoices');
    await act(async () => setScreenSharingPrivacyActive(true));
    expect(hook.getCurrent().selected).toBeNull();
    expect(bindings.selected.value.sessionId).toBe(session.id);
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(hook.getCurrent().selected).toBe('Secret invoices');
  } finally { await hook.unmount(); setScreenSharingPrivacyActive(false); storage.setState(previous, true); }
});

it('names machine pins from the exact Home inventory and updates their live display name', async () => {
  const previous = storage.getState();
  const machine = createMachineFixture({ id: 'shared-id', metadata: { ...createMachineFixture().metadata!, displayName: 'My workstation' } });
  try {
    storage.setState({ machines: {}, machineListByServerId: { home: [machine], other: [{ ...machine,
      metadata: { ...machine.metadata!, displayName: 'Another Home workstation' } }] }, machineListStatusByServerId: { home: 'idle', other: 'idle' } });
    const candidate = { inputs: { fields: [{ path: 'machine', title: 'Machine', widget: 'select' as const,
      inputType: { hostType: 'machine' as const } }] } };
    const hook = await renderHook(() => useWidgetInstanceBindingLabel({ bindings: {
      machine: { kind: 'value', value: { serverId: 'home', machineId: machine.id } },
    } }, candidate));
    expect(hook.getCurrent()).toBe('My workstation');
    await act(async () => storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId,
      home: [{ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed workstation' } }] } }));
    expect(hook.getCurrent()).toBe('Renamed workstation');
    await hook.unmount();
  } finally { storage.setState(previous, true); }
});

it('names declared Session pins and group followers by their exact Home-qualified Session, and checkout pins by the workspace owner', async () => {
  const fields: InputHints['fields'] = [{ path: 'session', title: 'Session', widget: 'json', inputType: { hostType: 'session' } },
    { path: 'checkout', title: 'Checkout', widget: 'json', inputType: { hostType: 'workspace' } }];
  const session = createSessionFixture({ id: 'B', serverId: 'home', metadata: { path: '/repo', host: 'host', name: 'Review invoices' } });
  storage.setState({ sessions: { ...storage.getState().sessions, B: session } });
  const context = { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } },
    checkout: { kind: 'value' as const, value: { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: 'C:\\work\\happier', createdAtMs: 0 } } };
  const native = { inputs: { fields: [fields[0]!] } };
  const hook = await renderHook(() => useWidgetInstanceBindingLabel({ bindings: { session: context.session } }, native));
  expect(hook.getCurrent()).toBe('Review invoices');
  const checkout = await renderHook(() => useWidgetInstanceBindingLabel({ bindings: { checkout: context.checkout } }, { inputs: { fields: [fields[1]!] } }));
  expect(checkout.getCurrent()).toBe('happier');
  const groupLabels = await renderHook(() => useWidgetBindingValueLabels(context, { inputs: { fields } }));
  const labels = groupLabels.getCurrent();
  expect(labels).toEqual({ session: 'Review invoices', checkout: 'happier' });
  expect(describeWidgetGroupContext(context, labels)).toBe('Review invoices');
  expect(readWidgetGroupFollowedValue({ bindings: { session: { kind: 'context', slot: 'session' } } }, context, labels)).toBe('Review invoices');
  expect(widgetGroupSurfaceContext({}, context, labels).slots?.checkout?.value?.label).toBe('happier');
  await act(async () => storage.setState({ sessions: { ...storage.getState().sessions, B: { ...session, serverId: 'other', metadata: { ...session.metadata!, name: 'Other Home' } } } }));
  await hook.rerender();
  expect(hook.getCurrent()).toBeNull();
  await groupLabels.rerender();
  expect(describeWidgetGroupContext(context, groupLabels.getCurrent())).toBe('happier');
});

it('retains an installed descriptor explicit Session target even without field hints', async () => {
  const session = createSessionFixture({ id: 'installed', serverId: 'home', metadata: { path: '/repo', host: 'host', name: 'Installed Session' } });
  storage.setState({ sessions: { ...storage.getState().sessions, installed: session } });
  const hook = await renderHook(() => useWidgetInstanceBindingLabel({ bindings: {
    selected: { kind: 'value', value: { serverId: 'home', sessionId: 'installed' } },
  } }, { sessionInputPath: 'selected' }));
  expect(hook.getCurrent()).toBe('Installed Session');
});

const label = async (
  inputs: InputHints,
  bindings: Record<string, { kind: 'value'; value: string }>,
) =>
  (
    await renderHook(() =>
      useWidgetInstanceBindingLabel({ bindings }, { inputs }),
    )
  ).getCurrent();

it('names a copy by its chosen option words or its typed text, never by a stored machine value', async () => {
  const choice: InputHints = {
    fields: [
      {
        path: 'costBasis',
        widget: 'select',
        title: 'Cost',
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'reported', label: 'Reported' },
        ],
      },
    ],
  };
  expect(
    await label(choice, { costBasis: { kind: 'value', value: 'auto' } }),
  ).toBe('Automatic');
  // A stored choice whose words are not known here leaves the slot to the widget's own source.
  expect(
    await label(choice, { costBasis: { kind: 'value', value: 'estimated' } }),
  ).toBeNull();
  const sourced: InputHints = {
    fields: [
      {
        path: 'repository',
        widget: 'select',
        title: 'Repository',
        optionsSourceId: 'acme.repositories',
      },
    ],
  };
  expect(
    await label(sourced, {
      repository: { kind: 'value', value: 'repo_01HZX' },
    }),
  ).toBeNull();
  const typed: InputHints = {
    fields: [{ path: 'branch', widget: 'text', title: 'Branch' }],
  };
  expect(await label(typed, { branch: { kind: 'value', value: 'main' } })).toBe(
    'main',
  );
});

it('does not name a copy by a typed filesystem path, which is a location and not a name', async () => {
  const typed: InputHints = { fields: [{ path: 'directory', widget: 'text', title: 'Directory' }] };
  for (const path of ['/home/happier/happier-dev/packages', '~/work/happier', 'C:\\Users\\alice\\work', '\\\\server\\share'])
    expect(await label(typed, { directory: { kind: 'value', value: path } })).toBeNull();
  expect(await label(typed, { directory: { kind: 'value', value: 'happier-dev' } })).toBe('happier-dev');
});

it('resolves a JSON choice by the canonical option identity rather than raw object names', async () => {
  const inputs: InputHints = { fields: [{ path: 'filter', title: 'Filter', widget: 'json', options: [
    { value: { name: 'stored-id', period: 'month' }, label: 'Monthly costs' },
  ] }] };
  const hook = await renderHook(() => useWidgetInstanceBindingLabel({ bindings: {
    filter: { kind: 'value', value: { period: 'month', name: 'stored-id' } },
  } }, { inputs }));
  expect(hook.getCurrent()).toBe('Monthly costs');
});

it('tells a copy that follows its surface slot from one pinned to a value, so a page that names its slot can leave it out', () => {
  const context = { slots: { checkout: { label: 'This checkout', value: { value: 'wr_1', label: 'main' } } } };
  expect(isWidgetFollowingSurfaceSlot({ bindings: { target: { kind: 'context', slot: 'checkout' } } }, context)).toBe(true);
  expect(isWidgetFollowingSurfaceSlot({ bindings: { target: { kind: 'value', value: 'wr_2' } } }, context)).toBe(false);
  // A slot the surface does not offer is not "its own".
  expect(isWidgetFollowingSurfaceSlot({ bindings: { target: { kind: 'context', slot: 'filter' } } }, context)).toBe(false);
  expect(isWidgetFollowingSurfaceSlot({ bindings: { target: { kind: 'context', slot: 'checkout' } } }, {})).toBe(false);
});
