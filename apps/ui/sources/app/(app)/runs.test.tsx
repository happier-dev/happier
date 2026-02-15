import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineExecutionRunsListArgs = [string, Record<string, unknown>?];

const machineExecutionRunsListSpy = vi.fn(async (..._args: MachineExecutionRunsListArgs) => ({
  ok: true,
  runs: [],
}));
const stackScreenSpy = vi.fn((_props: any) => null);

vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  RefreshControl: 'RefreshControl',
}));

const routerMock = { push: vi.fn(), back: vi.fn(), replace: vi.fn(), navigate: vi.fn() };
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  Stack: { Screen: (props: any) => stackScreenSpy(props) },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        surface: '#111',
        surfaceHigh: '#222',
        divider: '#333',
        text: '#eee',
        textSecondary: '#aaa',
        header: { tint: '#eee' },
        status: { error: '#f00' },
      },
    },
  }),
  StyleSheet: { create: (fn: any) => (typeof fn === 'function' ? fn({ colors: {} }) : fn) },
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (_props: any) => null,
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({
  ExecutionRunRow: (_props: any) => null,
}));

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } }));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
  machineExecutionRunsList: (...args: MachineExecutionRunsListArgs) => machineExecutionRunsListSpy(...args),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineStopSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/domains/state/storage', () => {
  const machines = [
    {
      id: 'machine-1',
      active: true,
      createdAt: 1,
      updatedAt: 1,
      activeAt: Date.now(),
      metadata: { host: 'a.local', happyCliVersion: '1.0.0', happyHomeDir: '/tmp', homeDir: '/tmp' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 1,
      seq: 0,
    },
  ];
  const machineListByServerId = { 'server-a': machines as any };
  const machineListStatusByServerId = { 'server-a': 'idle' as const };
  return {
    useMachineListByServerId: () => machineListByServerId,
    useMachineListStatusByServerId: () => machineListStatusByServerId,
    useSetting: () => false,
  };
});

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));

describe('Runs screen', () => {
  it('configures a header title and right-side icon actions', async () => {
    stackScreenSpy.mockClear();
    const Screen = (await import('./runs')).default;

    await act(async () => {
      renderer.create(React.createElement(Screen));
      await Promise.resolve();
    });

    expect(stackScreenSpy).toHaveBeenCalled();
    const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
    expect(stackOptions?.headerTitle).toBe('Runs');
    expect(typeof stackOptions?.headerRight).toBe('function');

    const headerRightTree = renderer.create(React.createElement(stackOptions.headerRight));
    const rightButtons = headerRightTree.root.findAllByType('Pressable');
    const labels = rightButtons.map((button: any) => button.props.accessibilityLabel);
    expect(labels).toContain('Refresh runs');
    expect(labels).toContain('Toggle finished runs');
  });

  it('constrains runs content to the shared max width', async () => {
    const Screen = (await import('./runs')).default;

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(Screen));
      await Promise.resolve();
    });

    const views = tree!.root.findAllByType('View');
    const hasConstrainedContainer = views.some((node: any) => {
      const raw = node.props.style;
      const styles = Array.isArray(raw) ? raw : [raw];
      return styles.some((entry: any) => {
        if (!entry || typeof entry !== 'object') return false;
        return entry.maxWidth === 999 && entry.width === '100%' && entry.alignSelf === 'center';
      });
    });

    expect(hasConstrainedContainer).toBe(true);
  });

  it('lists daemon execution runs for machines in the server-scoped machine cache', async () => {
    machineExecutionRunsListSpy.mockClear();

    const Screen = (await import('./runs')).default;

    await act(async () => {
      renderer.create(React.createElement(Screen));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
  });
});
