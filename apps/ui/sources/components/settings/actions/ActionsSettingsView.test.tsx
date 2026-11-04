import * as React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderRealScreen, standardCleanup } from '@/dev/testkit';
import {
  installSettingsViewCommonModuleMocks,
  resetSettingsViewCommonModuleMockState,
} from '../settingsViewTestHelpers';
import {
  createUseSettingMock,
} from '@/dev/testkit/mocks/storage';
import {
  createMachineAdministrationTargetSelectionMock,
  installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
  virtualizedListProps: null as Record<string, unknown> | null,
  windowWidth: 800,
  routerPush: vi.fn(),
  reset() {
    this.virtualizedListProps = null;
    this.windowWidth = 800;
    this.routerPush.mockReset();
  },
}));

const administrationTargetSelection =
  createMachineAdministrationTargetSelectionMock({
    selectedMachineId: null,
    machines: [
      { machineId: 'machine-a', displayName: 'Machine A' },
      { machineId: 'machine-b', displayName: 'Machine B' },
    ],
  });
installMachineAdministrationTargetSelectionBoundary(
  administrationTargetSelection,
);
const administrationSelectionCalls: Array<
  Readonly<{
    selectionKey: string;
    options: unknown;
  }>
> = [];
vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => ({
  ...administrationTargetSelection.module,
  useMachineAdministrationTargetSelection: (
    selectionKey: string,
    options: unknown,
  ) => {
    administrationSelectionCalls.push({ selectionKey, options });
    return administrationTargetSelection.module.useMachineAdministrationTargetSelection(
      selectionKey,
    );
  },
}));

const daemonProjection = vi.hoisted(() => ({
  calls: [] as Array<
    Readonly<{ machineId?: unknown; serverId?: unknown; enabled?: unknown }>
  >,
  byMachineId: {} as Record<string, unknown>,
  reset() {
    this.calls = [];
    this.byMachineId = {};
  },
}));

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  const legendList = createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
    renderItems: true,
  });
  return {
    ...legendList.module,
    LegendList: (props: Record<string, unknown>) => {
      capture.virtualizedListProps = props;
      return React.createElement(legendList.module.LegendList, props);
    },
  };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: (
    params: Readonly<{
      machineId?: unknown;
      serverId?: unknown;
      enabled?: unknown;
    }>,
  ) => {
    daemonProjection.calls.push(params);
    const machineId =
      typeof params.machineId === 'string' ? params.machineId : '';
    return (
      daemonProjection.byMachineId[machineId] ?? { phase: 'idle', inputs: null }
    );
  },
}));

installSettingsViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } =
      await import('@/dev/testkit/mocks/virtualizedList');
    const flatList = createCapturingFlatListMock({ renderItems: true });
    return createReactNativeWebMock({
      FlatList: (props: Record<string, unknown>) => {
        capture.virtualizedListProps = props;
        return flatList.module.FlatList(props);
      },
      useWindowDimensions: () => ({
        width: capture.windowWidth,
        height: 844,
        scale: 2,
        fontScale: 1,
      }),
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: {
        push: capture.routerPush,
      },
    }).module;
  },
  storage: async (importOriginal) => {
    const { createStorageModuleMock } =
      await import('@/dev/testkit/mocks/storage');
    const { settingsDefaults } =
      await import('@/sync/domains/settings/settings');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        useSetting: createUseSettingMock({
          values: {
            voice: {
              ...settingsDefaults.voice,
              privacy: { ...settingsDefaults.voice.privacy, shareDeviceInventory: true },
            },
          },
          fallback: key => settingsDefaults[key],
        }),
      },
    });
  },
});







afterEach(() => {
  standardCleanup();
  capture.reset();
  administrationTargetSelection.controller.reset();
  administrationSelectionCalls.length = 0;
  daemonProjection.reset();
  resetSettingsViewCommonModuleMockState();
});

// Resolve the catalog graph during collection, outside individual render-test deadlines.
const { ActionsSettingsView } = await import('./ActionsSettingsView');
const { Item } = await import("@/components/ui/lists/Item");
const { ItemGroup } = await import("@/components/ui/lists/ItemGroup");
const { CompactSearchField } = await import("@/components/ui/forms/CompactSearchField");
let renderedScreen: Awaited<ReturnType<typeof renderRealScreen>> | null = null;
async function renderScreen(...args: Parameters<typeof renderRealScreen>) {
    renderedScreen = await renderRealScreen(...args);
    return renderedScreen;
}
function renderedProps(component: React.ElementType): Array<Record<string, unknown>> {
    return renderedScreen?.findAllByType(component).map(node => node.props) ?? [];
}


describe('ActionsSettingsView', () => {
  it('virtualizes the full catalog as bounded family segments', async () => {
    await renderScreen(<ActionsSettingsView />);

    expect(capture.virtualizedListProps).toEqual(expect.objectContaining({
      recycleItems: true,
      estimatedItemSize: 560,
    }));
    const segments = capture.virtualizedListProps?.data as
      | ReadonlyArray<{ items: readonly unknown[] }>
      | undefined;
    expect(segments?.length).toBeGreaterThan(1);
    expect(Math.max(...(segments ?? []).map((segment) => segment.items.length))).toBeLessThanOrEqual(8);
  });

  it('shows separate Resources reading and changing sections', async () => {
    await renderScreen(<ActionsSettingsView />);

    expect(renderedProps(ItemGroup).map(props => props.title)).toContain(
      'settingsActions.families.resources.reading.title',
    );
    expect(renderedProps(ItemGroup).map(props => props.title)).toContain(
      'settingsActions.families.resources.changing.title',
    );
    expect(
      renderedProps(Item).some(
        (item) => item.testID === 'settings-actions:action:machines.vitals.get',
      ),
    ).toBe(true);
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:machines.storage.trash.move',
      ),
    ).toBe(true);
  });

  it('links Resources · changing to the session stop Action that keeps its own family', async () => {
    capture.reset();
    await renderScreen(<ActionsSettingsView />);

    const link = renderedProps(Item).find(
      (item) => item.testID === 'settings-actions:related:session.stop',
    );
    expect(link).toBeTruthy();
    (link?.onPress as undefined | (() => void))?.();
    expect(capture.routerPush).toHaveBeenCalledWith(
      '/settings/actions/session.stop',
    );
    // One membership per Action: the row itself stays in its own family.
    expect(
      renderedProps(Item).filter(
        (item) => item.testID === 'settings-actions:action:session.stop',
      ),
    ).toHaveLength(1);
  });

  it('renders actions as a searchable list without inline target controls', async () => {
    capture.reset();
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);

    expect(renderedProps(CompactSearchField)).toHaveLength(1);
    expect(
      renderedProps(Item).some(
        (item) => item.testID === 'settings-actions:action:review.start',
      ),
    ).toBe(true);
    expect(
      renderedProps(Item).every((item) =>
        String(item.testID).startsWith('settings-actions:action:')
        || String(item.testID).startsWith('settings-actions:related:'),
      ),
    ).toBe(true);
  });

  it('uses the canonical machine selection for contributed-action scoping and never mixes daemon projections', async () => {
    capture.reset();
    daemonProjection.byMachineId = {
      'machine-a': {
        phase: 'ready',
        inputs: {
          pluginProjectionById: {
            'com.acme.a': {
              pluginId: 'com.acme.a',
              actions: [
                {
                  id: 'review/a',
                  title: 'Action from machine A',
                  description: null,
                  icon: null,
                  surfaces: ['plugin'],
                  placementBindings: [],
                },
              ],
            },
          },
        },
      },
      'machine-b': {
        phase: 'ready',
        inputs: {
          pluginProjectionById: {
            'com.acme.b': {
              pluginId: 'com.acme.b',
              actions: [
                {
                  id: 'review/b',
                  title: 'Action from machine B',
                  description: null,
                  icon: null,
                  surfaces: [],
                  placementBindings: [],
                },
              ],
            },
          },
        },
      },
    };
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);
    expect(administrationSelectionCalls).toContainEqual({
      selectionKey: 'actions.settings',
      options: undefined,
    });
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID ===
          'settings-actions:contributed:machine-selection-required',
      ),
    ).toBe(false);
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:com.acme.a/actions/review/a',
      ),
    ).toBe(false);
    await act(async () => {
      administrationTargetSelection.controller.select('machine-a');
    });
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:com.acme.a/actions/review/a',
      ),
    ).toBe(true);
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:com.acme.b/actions/review/b',
      ),
    ).toBe(false);
    await act(async () => {
      administrationTargetSelection.controller.select('machine-b');
    });
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:com.acme.a/actions/review/a',
      ),
    ).toBe(false);
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:com.acme.b/actions/review/b',
      ),
    ).toBe(true);
  });

  it('exposes browser recording attach in action settings now its executor is wired (§3.2)', async () => {
    // FINALIZATION-PLAN §3.2/§3.3: `browser.recording.attachToComposer` has a real executor and
    // is surfaced on ui/agent, so it is now a configurable settings row. The no-executor
    // related executor-backed recording actions are configurable; unrelated families stay hidden.
    capture.reset();
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);

    const searchHeader = renderedProps(CompactSearchField)[0];
    expect(typeof searchHeader?.onChangeText).toBe('function');
    await act(async () => {
      (searchHeader?.onChangeText as (value: string) => void)('browser');
    });

    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID ===
          'settings-actions:action:browser.recording.attachToComposer',
      ),
    ).toBe(true);
    expect(
      renderedProps(Item).some(
        (item) =>
          item.testID === 'settings-actions:action:browser.recording.start',
      ),
    ).toBe(true);
    expect(
      renderedProps(Item).some(
        (item) => item.testID === 'settings-actions:action:review.start',
      ),
    ).toBe(false);
  });

  it('groups actions into runtime family sections with localized headers (§3.3)', async () => {
    capture.reset();
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);

    const searchHeader = renderedProps(CompactSearchField)[0];
    await act(async () => {
      (searchHeader?.onChangeText as (value: string) => void)('browser');
    });

    // A Browser family section header is rendered, and the grouped rows are browser actions.
    expect(renderedProps(ItemGroup).map(props => props.title)).toContain(
      'settingsActions.families.browser.title',
    );
    expect(
      renderedProps(Item).some(
        (item) => item.testID === 'settings-actions:action:browser.navigate',
      ),
    ).toBe(true);
  });

  it('opens an action detail page from the action row without toggling action enablement', async () => {
    capture.reset();
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);

    const reviewRow = renderedProps(Item).find(
      (item) => item.testID === 'settings-actions:action:review.start',
    );
    expect(reviewRow).toBeTruthy();

    const onPress = reviewRow?.onPress as undefined | (() => void);
    expect(typeof onPress).toBe('function');
    onPress?.();

    expect(capture.routerPush).toHaveBeenCalledWith(
      '/settings/actions/review.start',
    );
  });

  it('percent-encodes a qualified contributed action id when opening its detail page', async () => {
    daemonProjection.byMachineId = {
      'machine-a': {
        phase: 'ready',
        inputs: {
          pluginProjectionById: {
            'happier.inspector': {
              pluginId: 'happier.inspector',
              actions: [
                {
                  id: 'self-check',
                  title: 'Run Inspector self-check',
                  description: 'Checks the Inspector plugin.',
                  icon: null,
                  surfaces: ['ui'],
                  placementBindings: ['toolbar'],
                },
              ],
            },
          },
        },
      },
    };
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    await renderScreen(<ActionsSettingsView />);
    await act(async () => {
      administrationTargetSelection.controller.select('machine-a');
    });

    const inspectorRow = renderedProps(Item).find(
      (item) =>
        item.testID ===
        'settings-actions:action:happier.inspector/actions/self-check',
    );
    expect(inspectorRow).toBeTruthy();

    (inspectorRow?.onPress as () => void)();

    expect(capture.routerPush).toHaveBeenCalledWith(
      '/settings/actions/happier.inspector%2Factions%2Fself-check',
    );
  });

  it('keeps the switch and settings affordance beside each action and the status in its text column', async () => {
    capture.reset();
    const { ActionsSettingsView } = await import('./ActionsSettingsView');

    const screen = await renderScreen(<ActionsSettingsView />);

    const reviewRow = renderedProps(Item).find(
      (item) => item.testID === 'settings-actions:action:review.start',
    );
    expect(reviewRow).toBeTruthy();
    expect(reviewRow?.showChevron).toBe(false);
    expect(reviewRow?.rightElementOutsidePressable).toBe(true);
    // Status reads under the description at every width; a narrow column beside the switch
    // wrapped one fact into four lines.
    expect(reviewRow?.subtitleAccessory).toBeTruthy();
    expect(
      await screen.findByTestId('settings-actions:action:review.start:status'),
    ).toBeTruthy();
    expect(screen.findAllByTestId('settings-actions:action:review.start:status-container')).toHaveLength(0);
    expect(
      await screen.findByTestId(
        'settings-actions:action:review.start:configure',
      ),
    ).toBeTruthy();
    expect(
      (
        await screen.findByTestId(
          'settings-actions:action:review.start:enabled',
        )
      )?.props.accessibilityLabel,
    ).toBe(reviewRow?.title);
  });
});
