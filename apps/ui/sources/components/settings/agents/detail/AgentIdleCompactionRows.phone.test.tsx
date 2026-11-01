import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

// The first render loads the settings page modules cold; the measured rows themselves are instant.
vi.setConfig({ testTimeout: 180_000 });

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

const TARGET = 'agent:acme.agent.relay/relay';
const MINUTES = 'settings.agents.detail.idleCompaction.cacheWindow.minutes';
const SIBLING_ROW_FIELD = 'settings.agents.detail.idleCompaction.minContextTokens.input';

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['findAll']>[number];

const styleOf = (node: Node) =>
  [node.props.style].flat(Infinity).filter(Boolean) as Array<
    Record<string, unknown>
  >;
const direction = (node: Node) =>
  styleOf(node).reduce<unknown>(
    (current, entry) => entry.flexDirection ?? current,
    undefined,
  );

/** Layout is the platform boundary: the window row and its accessory report their measured widths. */
async function renderCustomWindowRow() {
  const { act } = await import('react-test-renderer');
  const { storage } = await import('@/sync/domains/state/storage');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const { AgentIdleCompactionRows } = await import('./AgentIdleCompactionRows');
  storage.getState().applySettingsLocal({
    sessionIdleCompactionEnabledByTargetKey: { [TARGET]: true },
    sessionIdleCompactionCacheWindowOverrideMsByTargetKey: {
      [TARGET]: 45 * 60_000,
    },
  });
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <AgentIdleCompactionRows
        agentTargetKey={TARGET}
        compatibilityTargetKeys={[]}
        bundledAgentId={null}
        projectedCompaction={{
          events: true,
          idle: { mode: 'host', defaultEnabled: false },
        }}
        accountSettingsAvailable
      />
    </ListPresentationProvider>,
  );
  await screen.pressByTestIdAsync(
    'settings.agents.detail.idleCompaction.when.header',
  );
  const measured = () =>
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props?.onLayout === 'function' &&
        node.findAll((child) => child.props?.testID === MINUTES).length > 0 &&
        // The disclosure body also measures itself; the window row is the outermost host without its sibling row.
        node.findAll((child) => child.props?.testID === SIBLING_ROW_FIELD).length === 0,
    );
  const row = () => measured()[0]!;
  const accessory = () => measured()[measured().length - 1]!;
  const layout = async (
    widths: Readonly<{ row: number; accessory: number }>,
  ) => {
    await act(async () => {
      row().props.onLayout({
        nativeEvent: { layout: { width: widths.row, height: 72, x: 0, y: 0 } },
      });
    });
    await act(async () => {
      accessory().props.onLayout({
        nativeEvent: {
          layout: { width: widths.accessory, height: 40, x: 0, y: 0 },
        },
      });
    });
    // The label's natural width ("Cache window" is short), as the row measures it on a phone.
    const titleMeasures = screen.findAll((node) => typeof node.type === 'string'
      && typeof node.props?.onLayout === 'function'
      && node.findAll((child) => child.props?.testID === MINUTES).length === 0
      && node.findAll((child) => child.children?.includes?.('Cache window')).length > 0);
    for (const measure of titleMeasures) {
      await act(async () => {
        measure.props.onLayout({ nativeEvent: { layout: { width: 96, height: 20, x: 0, y: 0 } } });
      });
    }
  };
  return { screen, row, layout };
}

describe('Cache window row on a phone', () => {
  it('puts the Custom select and its minutes on their own line under the label and help (lab CCp)', async () => {
    const { row, layout } = await renderCustomWindowRow();
    // 390pt phone: a 358pt row; Custom + 45 + "minutes" measure about 270pt.
    await layout({ row: 358, accessory: 270 });
    expect(direction(row())).toBe('column');
  });

  it('keeps the compound controls beside the label on a desktop row', async () => {
    const { row, layout } = await renderCustomWindowRow();
    await layout({ row: 760, accessory: 270 });
    expect(direction(row())).not.toBe('column');
  });
});
