import { afterEach, expect, it } from 'vitest';
import type { InputHints } from '@happier-dev/protocol/inputs';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { useWidgetInstanceBindingLabel } from './useWidgetInstanceBindingLabel';
import { describeWidgetGroupContext, readWidgetGroupFollowedValue, widgetGroupSurfaceContext } from '../group/widgetGroupInputs';

afterEach(() => standardCleanup());

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
  const labels = { session: hook.getCurrent()!, checkout: checkout.getCurrent()! };
  expect(describeWidgetGroupContext(context, labels)).toBe('Review invoices');
  expect(readWidgetGroupFollowedValue({ bindings: { session: { kind: 'context', slot: 'session' } } }, context, labels)).toBe('Review invoices');
  expect(widgetGroupSurfaceContext({}, context, labels).slots?.checkout?.value?.label).toBe('happier');
  storage.setState({ sessions: { ...storage.getState().sessions, B: { ...session, serverId: 'other', metadata: { ...session.metadata!, name: 'Other Home' } } } });
  await hook.rerender();
  expect(hook.getCurrent()).toBeNull();
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
