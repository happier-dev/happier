import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { InboxPluginSessionRow } from './inboxItemProjection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return await createReactNativeWebMock({
    Pressable: ({ children, ...props }: any) =>
      React.createElement(
        'Pressable',
        props,
        typeof children === 'function'
          ? children({ pressed: false })
          : children,
      ),
    View: 'View',
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
const push = vi.hoisted(() => vi.fn());
vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
  useRouter: () => ({ push }),
}));

const row: InboxPluginSessionRow = {
  key: 'happier.triage:session-pull-request-inbox-v1:s1',
  pluginId: 'happier.triage',
  indexResourceId: 'session-pull-request-inbox-v1',
  row: {
    id: 's1',
    session: { serverId: 'home-1', sessionId: 's1' },
    title: 'acme/widgets#42',
    detail: '1 failed check',
    detailResource: {
      pluginId: 'happier.triage',
      resourceId: 'session-pull-request-status-v1',
    },
  },
  controls: [
    {
      id: 'continue:b1',
      label: 'Continue fixing',
      effect: {
        kind: 'action',
        invocation: {
          action: {
            pluginId: 'happier.channels',
            localId: 'session-pull-request-watch-v1',
          },
          input: {},
        },
      },
    } as never,
    {
      id: 'stop:b1',
      label: 'Stop watching',
      effect: {
        kind: 'action',
        invocation: {
          action: {
            pluginId: 'happier.channels',
            localId: 'session-pull-request-watch-v1',
          },
          input: {},
        },
      },
    } as never,
  ],
};

function hostNodes(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => typeof node.type === 'string' && (node.props as { testID?: string }).testID === testID);
}

/** The pressable that owns a control's test id, whatever wrapper the button primitive draws around it. */
function pressable(tree: renderer.ReactTestRenderer, testID: string) {
  const found = tree.root.findAll((node) => (node.props as { testID?: string }).testID === testID
    && typeof (node.props as { onPress?: unknown }).onPress === 'function');
  if (found.length === 0) throw new Error(`No pressable ${testID}`);
  return found[0]!.props as { onPress: () => unknown };
}

describe('Inbox plugin Session lines', () => {
  it('says what the plugin reports and presses each declared control through the viewer’s front door', async () => {
    const { InboxPluginSessionLines } =
      await import('./InboxPluginSessionLines');
    const invoke = vi.fn(
      async () => ({ kind: 'action', result: { ok: true } }) as never,
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <InboxPluginSessionLines rows={[row]} invoke={invoke} testID="lines" />,
      );
    });
    expect(JSON.stringify(tree.toJSON())).toContain(
      'acme/widgets#42 · 1 failed check',
    );
        await act(async () => {
      await pressable(tree, 'lines.control.stop:b1').onPress();
    });
    expect(invoke).toHaveBeenCalledWith(row, 'stop:b1');
    expect(hostNodes(tree, 'lines.failed')).toHaveLength(0);
  }, 120_000);

  it('says a control that could not run did not go through', async () => {
    const { InboxPluginSessionLines } =
      await import('./InboxPluginSessionLines');
    const invoke = vi.fn(async () => ({ kind: 'unavailable' }) as const);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <InboxPluginSessionLines rows={[row]} invoke={invoke} testID="lines" />,
      );
    });
        await act(async () => {
      await pressable(tree, 'lines.control.stop:b1').onPress();
    });
    expect(hostNodes(tree, 'lines.failed')).toHaveLength(1);
  });
  it('says a press the Action refused did not go through, and stays quiet when it worked', async () => {
    const { InboxPluginSessionLines } =
      await import('./InboxPluginSessionLines');
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'action',
        result: { ok: false, errorCode: 'stale_revision', error: 'stale_revision' },
      })
      .mockResolvedValueOnce({ kind: 'action', result: { ok: true, result: {} } });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <InboxPluginSessionLines rows={[row]} invoke={invoke} testID="lines" />,
      );
    });
    await act(async () => {
      await pressable(tree, 'lines.control.continue:b1').onPress();
    });
    expect(hostNodes(tree, 'lines.failed')).toHaveLength(1);
    await act(async () => {
      await pressable(tree, 'lines.control.continue:b1').onPress();
    });
    expect(hostNodes(tree, 'lines.failed')).toHaveLength(0);
  }, 120_000);

  it('lets one press finish before another control on the row can fire', async () => {
    const { InboxPluginSessionLines } =
      await import('./InboxPluginSessionLines');
    let finish!: () => void;
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'action', result: { ok: true, result: {} } });
        }),
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <InboxPluginSessionLines rows={[row]} invoke={invoke as never} testID="lines" />,
      );
    });
    act(() => {
      void pressable(tree, 'lines.control.continue:b1').onPress();
    });
    act(() => {
      void pressable(tree, 'lines.control.stop:b1').onPress();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    act(() => {
      void pressable(tree, 'lines.control.stop:b1').onPress();
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  }, 120_000);
});
