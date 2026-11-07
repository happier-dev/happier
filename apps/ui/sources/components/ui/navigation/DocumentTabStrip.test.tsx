import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Color from 'color';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { readGlassVariablesAt, resolveGlassPaint } from '@/dev/testkit/glass/resolveGlassPaint';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import {
  DocumentTabStrip,
  type DocumentTabItem,
  type DocumentTabPresentation,
} from './DocumentTabStrip';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import {
  createRenderCommitCounter,
  useRenderCommitCounter,
} from '@/dev/testkit/performance/counts';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
  resolveCompactAppDestinations,
  resolveDestinationRefFromHref,
  useDestinationInstanceTitleSources,
  type CompactAppDestination,
  type DestinationInstanceTitleEntry,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/** The node mock sees React Native's host ScrollView by its mocked host name. */
const isHostScrollView = (type: unknown) => type === 'ScrollView';

installPanelCommonModuleMocks();

// Resolve the real material graph during collection, rather than charging its
// first source transform to one interaction test's deadline on a busy worker.
const { AppShellMaterialFrame } =
  await import('@/components/navigation/shell/AppShellMaterialFrame');
const { GlassMaterialSettingsProvider } =
  await import('@/components/ui/glass/useGlassMaterialSettings');
const { GlassRuntimeEnvironmentProvider } =
  await import('@/components/ui/glass/glassRuntimeEnvironment');
const { glassPresetMaterials } =
  await import('@/components/ui/glass/glassMaterial');
const { resolveGlassPresentationVariables } =
  await import('@/components/ui/glass/glassDocumentPresentation');

/** The bar mounts the tabs near its viewport; a viewport as wide as every tab shows them all. */
async function measureBarWideEnoughForEveryTab(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  tabCount: number,
) {
  const scroller = screen.root.findAll((node) => isHostScrollView(node.type))[0]!;
  await act(async () => {
    scroller.props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: tabCount * 146, height: 30 } },
    });
  });
}

function TabRenderProbe(
  props: Readonly<{
    counter: ReturnType<typeof createRenderCommitCounter>;
    id: string;
  }>,
) {
  useRenderCommitCounter(props.counter);
  return <View testID={`probe-${props.id}`} />;
}

function LiveTitleSourceStripFixture(
  props: Omit<React.ComponentProps<typeof LiveTabStripFixture>, 'tabs'> &
    Readonly<{
      entries: readonly DestinationInstanceTitleEntry[];
      catalog: readonly CompactAppDestination[];
    }>,
) {
  const sources = useDestinationInstanceTitleSources(
    props.catalog,
    props.entries,
  );
  const tabs = React.useMemo(
    () =>
      props.entries.map((entry) => ({
        key: entry.key,
        title: 'Restored tab',
        titleSource: sources.get(entry.key),
        isPinned: false,
        isPreview: false,
      })),
    [props.entries, sources],
  );
  return <LiveTabStripFixture {...props} tabs={tabs} />;
}

function LiveTabStripFixture(
  props: Readonly<{
    variant: 'strip' | 'bar' | 'rail';
    tabs: readonly DocumentTabItem[];
    active?: string;
    unsaved?: ReadonlySet<string>;
    presentations?: Readonly<Record<string, DocumentTabPresentation>>;
    renderIcon: (tab: DocumentTabItem, active: boolean) => React.ReactNode;
    runtime: ReturnType<typeof createEntityDragDropRuntime>;
    events: string[];
    current?: boolean;
    namespace?: string;
    testIdPrefix?: string;
    accountId?: string;
    acceptsTabs?: boolean;
  }>,
) {
  // This real root-store subscription deliberately reproduces the Workspace
  // caller's unrelated Session publication; no internal selector is mocked.
  const sessions = storage((state) => state.sessions);
  const version = sessions['tab-strip-background']?.updatedAt ?? 0;
  const scope = { serverId: 'home', accountId: props.accountId ?? 'account' };
  return (
    <DocumentTabStrip
      variant={props.variant}
      tabs={props.tabs}
      activeTabKey={props.active ?? 'tab-0'}
      accessibilityLabel="Documents"
      unsavedTabKeys={props.unsaved}
      onActivate={(key) => props.events.push(`activate:${version}:${key}`)}
      onPin={(key) => props.events.push(`pin:${version}:${key}`)}
      onUnpin={(key) => props.events.push(`unpin:${version}:${key}`)}
      onClose={(key) => props.events.push(`close:${version}:${key}`)}
      onTabMenu={(key) => props.events.push(`menu:${version}:${key}`)}
      onDismissTabMenu={(key) => props.events.push(`dismiss:${version}:${key}`)}
      renderLeadingIcon={props.renderIcon}
      resolveTabPresentation={(tab) => props.presentations?.[tab.key] ?? null}
      tabNativeId={(key) => `${props.namespace ?? 'tab'}-${key}`}
      panelNativeId={(key) => `${props.namespace ?? 'panel'}-${key}`}
      testIds={{
        tab: (key) => `${props.testIdPrefix ?? 'live'}-${key}`,
        tabClose: (key) => `close-${key}`,
        tabPin: (key) => `pin-${key}`,
        tabUnpin: (key) => `unpin-${key}`,
        tabStatus: (key) => `status-${key}`,
        tabUnsaved: (key) => `unsaved-${key}`,
      }}
      entityDragDrop={{
        runtime: props.runtime,
        id: 'live-strip',
        scope,
        acceptedKinds: props.acceptsTabs === false ? [] : ['workspace-tab'],
        isCurrent: () => props.current !== false,
        getItem: (tabId) => ({ kind: 'workspace-tab', scope, tabId }),
        resolve: ({ beforeTabId }) => ({
          status: 'allowed',
          effect: {
            actionId: 'workspace.tabs.open',
            input: { beforeTabId, version },
            preview: { verb: 'Move', target: beforeTabId ?? 'End' },
          },
        }),
        execute: async (effect) => {
          props.events.push(`drop:${version}:${JSON.stringify(effect.input)}`);
          return { status: 'applied' };
        },
      }}
    />
  );
}

function TabPressMenuFixture(
  props: Readonly<{
    runtime: ReturnType<typeof createEntityDragDropRuntime>;
    variant: 'bar' | 'rail';
    sourceOnly?: boolean;
  }>,
) {
  const [menu, setMenu] = React.useState<string | null>(null);
  const scope = { serverId: 'home', accountId: 'account' };
  const menuLifecycle = {
    onTabMenu: (key: string) => setMenu(key),
    onDismissTabMenu: (key: string) =>
      setMenu((current) => (current === key ? null : current)),
  };
  return (
    <View>
      <DocumentTabStrip
        {...menuLifecycle}
        variant={props.variant}
        tabs={[
          { key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false },
        ]}
        activeTabKey="anchor"
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        testIds={{ tab: (id) => `press-menu-${id}` }}
        entityDragSource={
          props.sourceOnly
            ? {
                runtime: props.runtime,
                id: 'press-menu',
                scope,
                getItem: (tabId) => ({ kind: 'workspace-tab', scope, tabId }),
              }
            : undefined
        }
        entityDragDrop={
          props.sourceOnly
            ? undefined
            : {
                runtime: props.runtime,
                id: 'press-menu',
                scope,
                acceptedKinds: ['workspace-tab'],
                getItem: (tabId) => ({ kind: 'workspace-tab', scope, tabId }),
                resolve: () => ({
                  status: 'refused',
                  reason: { code: 'no-change', message: 'Already here' },
                }),
                execute: async () => ({ status: 'applied' }),
              }
        }
      />
      {menu ? <View testID="open-tab-menu" /> : null}
    </View>
  );
}

describe('DocumentTabStrip actions', () => {
  it('keeps bar row indexing linear at 39 and 389 tabs and follows reordered keys', async () => {
    const measured: { tabs: number; mountReads: number; activationReads: number }[] = [];
    for (const tabCount of [39, 389]) {
      let reads = 0;
      // Observe real array element reads, including native indexOf comparisons;
      // preserve every input and array operation rather than stubbing indexing.
      const observe = (tabs: readonly DocumentTabItem[]) => new Proxy(tabs, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const rows = Array.from({ length: tabCount }, (_, index) => ({
        key: `tab-${index}`, title: `Tab ${index}`, isPinned: index === tabCount - 1, isPreview: false,
      }));
      const tabs = observe(rows);
      const props = { variant: 'bar' as const, runtime: createEntityDragDropRuntime(),
        events: [] as string[], renderIcon: () => null };
      const screen = await renderScreen(<LiveTabStripFixture {...props} tabs={tabs} />);
      try {
        const mountReads = reads;
        reads = 0;
        await screen.update(<LiveTabStripFixture {...props} tabs={tabs} active="tab-1" />);
        measured.push({ tabs: tabCount, mountReads, activationReads: reads });
        await screen.update(<LiveTabStripFixture {...props}
          tabs={observe([rows[tabCount - 1]!, ...rows.slice(0, -1)])} active="tab-0" />);
        props.events.length = 0;
        await act(async () => {
          screen.findHostByTestId('live-tab-0')!.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
        });
        expect(props.events.some(event => event.endsWith(`:tab-${tabCount - 1}`))).toBe(true);
      } finally {
        await screen.unmount();
      }
    }
    console.info('CREDFREEZE_INDEX_SCALE', JSON.stringify(measured));
    const [small, large] = measured;
    // Work per tab must not grow with inventory size, on mount or activation.
    expect.soft(large!.mountReads / large!.tabs).toBeLessThanOrEqual(small!.mountReads / small!.tabs);
    expect.soft(large!.activationReads / large!.tabs).toBeLessThanOrEqual(small!.activationReads / small!.tabs);
    for (const sample of measured) {
      expect.soft(sample.activationReads).toBeLessThan(sample.mountReads);
    }
  });

  it('subscribes in each of 153 real destination leaves and renders only the renamed Artifact', async () => {
    const original = storage.getState();
    const artifacts = Array.from(
      { length: 153 },
      (_, index): Extract<DecryptedArtifact, { isDecrypted: true }> => ({
        id: `artifact-${index}`,
        title: `Artifact ${index}`,
        isDecrypted: true,
        createdAt: 1,
        updatedAt: 1,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
      }),
    );
    storage
      .getState()
      .activateProfileScope({ serverId: 'tab-home', accountId: 'tab-account' });
    storage.getState().applyArtifacts(artifacts, storage.getState().artifacts);
    const catalog = resolveCompactAppDestinations({
      pages: [],
      builtins: {
        externalSessions: false,
        inbox: true,
        workflows: false,
        friends: false,
      },
    });
    const entries = artifacts.map(
      (artifact, index): DestinationInstanceTitleEntry => ({
        key: `tab-${index}`,
        ref: resolveDestinationRefFromHref(
          catalog,
          `/artifacts/${artifact.id}`,
        )!,
      }),
    );
    const counters = entries.map(() => createRenderCommitCounter());
    const icons: string[] = [];
    const screen = await renderScreen(
      <LiveTitleSourceStripFixture
        variant="bar"
        entries={entries}
        catalog={catalog}
        runtime={createEntityDragDropRuntime()}
        events={[]}
        renderIcon={(tab) => {
          icons.push(tab.key);
          return (
            <TabRenderProbe
              id={tab.key}
              counter={counters[Number(tab.key.slice(4))]}
            />
          );
        }}
      />,
    );
    await measureBarWideEnoughForEveryTab(screen, 153);
    try {
      expect(icons).toHaveLength(153);
      icons.length = 0;
      counters.forEach((counter) => counter.reset());
      await act(async () =>
        storage
          .getState()
          .applyMachines([
            createMachineFixture({ id: 'title-source-background' }),
          ]),
      );
      expect(icons).toEqual([]);
      expect(counters.map((counter) => counter.read())).toEqual(
        entries.map(() => ({ renders: 0, commits: 0 })),
      );
      await act(async () =>
        storage.getState().applyArtifacts(
          artifacts.map((artifact, index) =>
            index === 37
              ? { ...artifact, title: 'Renamed artifact', updatedAt: 2 }
              : artifact,
          ),
          storage.getState().artifacts,
        ),
      );
      expect(icons).toEqual(['tab-37']);
      expect(
        counters
          .filter((_, index) => index !== 37)
          .map((counter) => counter.read()),
      ).toEqual(entries.slice(1).map(() => ({ renders: 0, commits: 0 })));
      expect(
        screen
          .findHostByTestId('live-tab-37')!
          .findAll((node) => node.props.children === 'Renamed artifact'),
      ).not.toHaveLength(0);
    } finally {
      await screen.unmount();
      storage.setState(original, true);
    }
  });
  it.each(['bar', 'rail', 'strip'] as const)(
    'does no unchanged %s tab rendering for unrelated real Session publications',
    async (variant) => {
      const original = storage.getState();
      const tabs = Array.from({ length: 153 }, (_, index) => ({
        key: `tab-${index}`,
        title: `Document ${index}`,
        isPinned: false,
        isPreview: false,
      }));
      const counters = tabs.map(() => createRenderCommitCounter());
      const iconCalls: string[] = [];
      const renderIcon = (tab: DocumentTabItem) => {
        iconCalls.push(tab.key);
        return (
          <TabRenderProbe
            id={tab.key}
            counter={counters[Number(tab.key.slice(4))]}
          />
        );
      };
      const props = {
        variant,
        tabs,
        renderIcon,
        runtime: createEntityDragDropRuntime(),
        events: [] as string[],
      };
      const screen = await renderScreen(<LiveTabStripFixture {...props} />);
      if (variant === 'bar') await measureBarWideEnoughForEveryTab(screen, 153);
      try {
        expect(iconCalls).toHaveLength(153);
        iconCalls.length = 0;
        counters.forEach((counter) => counter.reset());
        for (let version = 1; version <= 3; version++) {
          await act(async () => {
            storage
              .getState()
              .applySessions([
                createSessionFixture({
                  id: 'tab-strip-background',
                  updatedAt: version,
                }),
              ]);
          });
        }
        expect(iconCalls).toEqual([]);
        expect(counters.map((counter) => counter.read())).toEqual(
          tabs.map(() => ({ renders: 0, commits: 0 })),
        );
        await act(async () => {
          storage
            .getState()
            .applyMachines([
              createMachineFixture({ id: 'strip-unrelated-machine' }),
            ]);
        });
        expect(iconCalls).toEqual([]);
        expect(counters.map((counter) => counter.read())).toEqual(
          tabs.map(() => ({ renders: 0, commits: 0 })),
        );
        const arriving = {
          key: 'tab-153',
          title: 'Arriving document',
          isPinned: false,
          isPreview: false,
        };
        counters.push(createRenderCommitCounter());
        await screen.update(
          <LiveTabStripFixture {...props} tabs={[...tabs, arriving]} />,
        );
        expect(iconCalls).toEqual(['tab-153']);
        expect(counters.slice(0, 153).map((counter) => counter.read())).toEqual(
          tabs.map(() => ({ renders: 0, commits: 0 })),
        );
        iconCalls.length = 0;
        await act(async () => {
          screen.findHostByTestId('live-tab-2')!.props.onPress();
        });
        expect(props.events).toContain('activate:3:tab-2');

        const renamed = tabs.map((tab) =>
          tab.key === 'tab-7' ? { ...tab, title: 'Renamed document' } : tab,
        );
        await screen.update(<LiveTabStripFixture {...props} tabs={renamed} />);
        expect(iconCalls).toEqual(['tab-7']);
        iconCalls.length = 0;
        await screen.update(
          <LiveTabStripFixture
            {...props}
            tabs={renamed}
            presentations={{
              'tab-8': { status: { tone: 'attention', label: 'Needs you' } },
            }}
          />,
        );
        expect(iconCalls).toEqual(['tab-8']);
        expect(
          screen.findHostByTestId('live-tab-8')!.props.accessibilityLabel,
        ).toContain('Needs you');
        iconCalls.length = 0;
        await screen.update(
          <LiveTabStripFixture
            {...props}
            tabs={renamed}
            active="tab-1"
            unsaved={new Set(['tab-9'])}
            presentations={{
              'tab-8': { status: { tone: 'attention', label: 'Needs you' } },
            }}
          />,
        );
        expect(iconCalls.sort()).toEqual(['tab-0', 'tab-1', 'tab-9']);
      } finally {
        await screen.unmount();
        storage.setState(original, true);
      }
    },
  );

  it.each(['bar', 'rail', 'strip'] as const)(
    'keeps %s visual callbacks, native identity and live drag admission current',
    async (variant) => {
      const original = storage.getState();
      const runtime = createEntityDragDropRuntime();
      const tabs = Array.from({ length: 3 }, (_, index) => ({
        key: `tab-${index}`,
        title: `Document ${index}`,
        isPinned: false,
        isPreview: false,
      }));
      const icons: string[] = [];
      const renderIcon = (tab: DocumentTabItem) => {
        icons.push(tab.key);
        return <View testID={`old-icon-${tab.key}`} />;
      };
      const events: string[] = [];
      const props = { variant, tabs, runtime, renderIcon, events };
      const screen = await renderScreen(<LiveTabStripFixture {...props} />);
      try {
        await act(async () => {
          storage
            .getState()
            .applySessions([
              createSessionFixture({
                id: 'tab-strip-background',
                updatedAt: 31,
              }),
            ]);
        });
        const sourceId = JSON.stringify([
          'document-tab',
          'live-strip',
          'tab-0',
          'source',
        ]);
        const target = runtime
          .getDestinations(sourceId)
          .find((destination) => destination.label === 'Document 2')!;
        await act(async () => {
          expect(
            await runtime.perform(
              sourceId,
              target.targetId,
              target.destination,
            ),
          ).toEqual({ status: 'applied' });
        });
        expect(events).toContain(
          'drop:31:{"beforeTabId":"tab-2","version":31}',
        );
        await act(async () => {
          screen.findHostByTestId('close-tab-0')!.props.onPress({});
        });
        expect(events).toContain('close:31:tab-0');

        icons.length = 0;
        await screen.update(
          <LiveTabStripFixture
            {...props}
            renderIcon={(tab) => {
              icons.push(tab.key);
              return <View testID={`new-icon-${tab.key}`} />;
            }}
            namespace="new-native"
            testIdPrefix="new-test"
          />,
        );
        expect(icons).toEqual(tabs.map((tab) => tab.key));
        expect(screen.findHostByTestId('new-icon-tab-2')).toBeTruthy();
        expect(screen.findHostByTestId('new-test-tab-2')!.props).toMatchObject({
          nativeID: 'new-native-tab-2',
          'aria-controls': 'new-native-tab-2',
        });
        const activated = events.length;
        await act(async () => {
          screen
            .findHostByTestId('new-test-tab-0')!
            .props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
        });
        expect(events.slice(activated)).toEqual(['activate:31:tab-1']);
        await screen.update(
          <LiveTabStripFixture {...props} acceptsTabs={false} />,
        );
        expect(runtime.getDestinations(sourceId)).toEqual([]);
        await screen.update(<LiveTabStripFixture {...props} />);
        let oldCarry!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => {
          oldCarry = runtime.begin(sourceId, 'keyboard')!;
          oldCarry.choose(target.targetId, target.destination);
        });
        const beforeScopeChange = events.length;
        const renamed = tabs.map((tab) =>
          tab.key === 'tab-0' ? { ...tab, title: 'Current source title' } : tab,
        );
        await screen.update(
          <LiveTabStripFixture
            {...props}
            tabs={renamed}
            accountId="replacement-account"
          />,
        );
        await act(async () => {
          expect(await oldCarry.release()).toBeNull();
        });
        expect(events.slice(beforeScopeChange)).toEqual([]);
        expect(runtime.describeSource(sourceId)?.title).toBe(
          'Current source title',
        );
        await screen.update(<LiveTabStripFixture {...props} current={false} />);
        expect(runtime.begin(sourceId, 'keyboard')).toBeNull();
        expect(runtime.getDestinations(sourceId)).toEqual([]);
      } finally {
        await screen.unmount();
        storage.setState(original, true);
      }
    },
  );

  it.each([
    ['bar', false],
    ['rail', false],
    ['rail', true],
  ] as const)(
    'retires the %s press menu on a real carry (source only: %s) and suppresses that press through drag end',
    async (variant, sourceOnly) => {
      const runtime = createEntityDragDropRuntime();
      const screen = await renderScreen(
        <TabPressMenuFixture
          runtime={runtime}
          variant={variant}
          sourceOnly={sourceOnly}
        />,
      );
      const tab = () => {
        const node = screen.findHostByTestId('press-menu-anchor');
        if (!node) throw new Error('Missing tab press boundary');
        return node;
      };
      await act(async () => {
        tab().props.onPressIn?.({});
        tab().props.onLongPress({});
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
      const pendingLongPress = tab().props.onLongPress;
      await act(async () => {
        runtime.begin(
          JSON.stringify(['document-tab', 'press-menu', 'anchor', 'source']),
          'pointer',
        );
      });
      expect(runtime.getSnapshot().phase).toBe('carrying');
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
      await act(async () => {
        pendingLongPress({});
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
      await act(async () => {
        runtime.cancel();
        pendingLongPress({});
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
      await act(async () => {
        tab().props.onPressIn?.({});
        tab().props.onLongPress({});
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
      await act(async () => {
        runtime.begin(
          JSON.stringify(['document-tab', 'press-menu', 'anchor', 'source']),
          'pointer',
        );
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
      await act(async () => {
        runtime.cancel();
        tab().props.onContextMenu({});
      });
      expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
      await screen.unmount();
    },
  );
  it('keeps active strip and focused bar tabs as ink within the containing material', async () => {
    const { useUnistyles } = await import('react-native-unistyles');
    const { theme } = useUnistyles();
    for (const variant of ['strip', 'bar', 'rail'] as const) {
      // The same element and callbacks survive the material change: a
      // context update, not incidental prop churn, must repaint the row.
      const strip = (
        <DocumentTabStrip
          variant={variant}
          tabs={[
            {
              key: 'active',
              title: 'Active',
              isPinned: false,
              isPreview: false,
            },
          ]}
          activeTabKey="active"
          accessibilityLabel="Documents"
          onActivate={() => {}}
          onPin={() => {}}
          onUnpin={() => {}}
          onClose={() => {}}
          renderLeadingIcon={() => null}
          tabNativeId={(id) => id}
          panelNativeId={(id) => id}
          testIds={{ tab: (id) => `material-tab-${id}` }}
        />
      );
      const frame = (reduceTransparency: boolean) => (
        <GlassRuntimeEnvironmentProvider
          value={{
            desktopWindow: true,
            nativeWindowMaterialLive: true,
            reduceTransparency,
          }}
        >
          <GlassMaterialSettingsProvider
            value={{
              glassBlurEnabled: true,
              glassSurfaceMaterials: glassPresetMaterials('everywhere'),
            }}
          >
            <AppShellMaterialFrame
              showChrome={false}
              dragEnabled={false}
              leftOffsetPx={0}
              sidebarWidth={320}
              titleStrip={null}
              rail={null}
              column={null}
              peek={null}
            >
              {strip}
            </AppShellMaterialFrame>
          </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>
      );
      const screen = await renderScreen(frame(false));
      for (const reduceTransparency of [false, true]) {
        if (reduceTransparency) await screen.update(frame(true));
        let node = screen.findHostByTestId('material-tab-active');
        let paint: string | undefined;
        while (node && paint === undefined) {
          const color = StyleSheet.flatten(node.props.style)?.backgroundColor;
          if (typeof color === 'string')
            // Web binds the tab to its containing material's CSS payload: read what the browser paints there.
            paint = resolveGlassPaint(color, readGlassVariablesAt(node, resolveGlassPresentationVariables(
              { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') },
              { desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency })));
          else node = node.parent;
        }
        expect(paint).toBeDefined();
        // The focused bar tab is a soft ink fill: the same ink over any material, never a solid coat.
        if (variant === 'bar')
          expect(Color(paint).hexa()).toBe(
            Color(theme.colors.surface.selectedFocused).hexa(),
          );
        else if (reduceTransparency)
          expect(Color(paint).hexa()).toBe(
            Color(
              variant === 'strip'
                ? theme.colors.surface.elevated
                : theme.colors.surface.selected,
            ).hexa(),
          );
        else expect(Color(paint).alpha()).toBeLessThan(1);
      }
      await screen.unmount();
    }
  });
  it('offers the same semantic before-tab destination to keyboard and chooser carries', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    runtime.registerSource({
      id: 'row',
      scope,
      isCurrent: () => true,
      getItem: () => ({ kind: 'destination', scope, href: '/inbox' }),
    });
    const writes: unknown[] = [];
    const screen = await renderScreen(
      <DocumentTabStrip
        variant="bar"
        tabs={[
          { key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false },
        ]}
        activeTabKey="anchor"
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        entityDragDrop={{
          runtime,
          id: 'strip',
          scope,
          acceptedKinds: ['destination', 'workspace-tab'],
          getItem: (tabId) => ({ kind: 'workspace-tab', scope, tabId }),
          resolve: ({ beforeTabId }) => ({
            status: 'allowed',
            effect: {
              actionId: 'workspace.tabs.open',
              input: { href: '/inbox', beforeTabId },
              preview: { verb: 'Open', target: 'Anchor' },
            },
          }),
          execute: async (effect) => {
            writes.push(effect.input);
            return { status: 'applied' };
          },
        }}
      />,
    );
    const destinations = runtime.getDestinations('row');
    expect(destinations).toHaveLength(1);
    await act(async () => {
      await runtime.perform(
        'row',
        destinations[0].targetId,
        destinations[0].destination,
      );
    });
    expect(writes).toEqual([{ href: '/inbox', beforeTabId: 'anchor' }]);
    await screen.unmount();
    expect(runtime.getDestinations('row')).toEqual([]);
  });
  it('marks the gap before an admitting tab, and lights nothing where the strip refuses', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    runtime.registerSource({
      id: 'row',
      scope,
      isCurrent: () => true,
      getItem: () => ({ kind: 'destination', scope, href: '/inbox' }),
    });
    const screen = await renderScreen(
      <DocumentTabStrip
        variant="bar"
        tabs={[
          { key: 'open', title: 'Open', isPinned: false, isPreview: false },
          { key: 'full', title: 'Full', isPinned: false, isPreview: false },
        ]}
        activeTabKey="open"
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        entityDragDrop={{
          runtime,
          id: 'strip',
          scope,
          acceptedKinds: ['destination'],
          getItem: () => null,
          resolve: ({ beforeTabId }) =>
            beforeTabId === 'open'
              ? {
                  status: 'allowed',
                  effect: {
                    actionId: 'workspace.tabs.open',
                    input: { beforeTabId },
                    preview: { verb: 'Open', target: 'Open' },
                  },
                }
              : { status: 'refused', reason: { code: 'no', message: 'No' } },
          execute: async () => ({ status: 'applied' }),
        }}
      />,
    );
    const targetFor = (key: string) =>
      runtime
        .getDestinations('row')
        .find((entry) => entry.label === (key === 'open' ? 'Open' : 'Full'))!;
    const carry = runtime.begin('row', 'keyboard');
    act(() =>
      carry?.choose(targetFor('open').targetId, targetFor('open').destination),
    );
    expect(
      screen.findHostByTestId('document-tab-drop-before-open'),
    ).toBeTruthy();
    act(() =>
      carry?.choose(targetFor('full').targetId, targetFor('full').destination),
    );
    expect(
      screen.findHostByTestId('document-tab-drop-before-open'),
    ).toBeFalsy();
    expect(
      screen.findHostByTestId('document-tab-drop-before-full'),
    ).toBeFalsy();
    act(() => carry?.cancel());
    await screen.unmount();
  });
  it.each(['bar', 'strip'] as const)(
    'keeps pinned needs-you status visible and named in the %s presentation',
    async (variant) => {
      const screen = await renderScreen(
        <DocumentTabStrip
          variant={variant}
          tabs={[
            {
              key: 'session',
              title: 'Fix layout',
              isPinned: true,
              isPreview: false,
            },
          ]}
          activeTabKey="session"
          accessibilityLabel="Workspace"
          onActivate={() => {}}
          onPin={() => {}}
          onUnpin={() => {}}
          onClose={() => {}}
          renderLeadingIcon={() => null}
          tabNativeId={(id) => `tab-${id}`}
          panelNativeId={(id) => `panel-${id}`}
          resolveTabPresentation={() => ({
            status: { tone: 'attention', label: 'Needs you' },
          })}
          testIds={{
            tab: (id) => `tab-${id}`,
            tabStatus: (id) => `status-${id}`,
          }}
        />,
      );
      expect(screen.findHostByTestId('status-session')).toBeTruthy();
      expect(
        screen.findByTestId('tab-session')?.props.accessibilityLabel,
      ).toContain('Needs you');
    },
  );

  it('keeps the Agent mark beside a background working spinner and the active close action', async () => {
    const screen = await renderScreen(
      <DocumentTabStrip
        variant="bar"
        tabs={[
          {
            key: 'active',
            title: 'Open session',
            isPinned: false,
            isPreview: false,
          },
          {
            key: 'background',
            title: 'Working session',
            isPinned: false,
            isPreview: false,
          },
        ]}
        activeTabKey="active"
        accessibilityLabel="Workspace"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={(tab) => <View testID={`agent-${tab.key}`} />}
        tabNativeId={(id) => `tab-${id}`}
        panelNativeId={(id) => `panel-${id}`}
        resolveTabPresentation={() => ({
          status: { tone: 'working', label: 'Working' },
        })}
        testIds={{
          tab: (id) => `tab-${id}`,
          tabSpinner: (id) => `spinner-${id}`,
          tabClose: (id) => `close-${id}`,
        }}
      />,
    );
    expect(screen.findHostByTestId('spinner-background')).toBeTruthy();
    expect(screen.findHostByTestId('spinner-active')).toBeFalsy();
    expect(screen.findByTestId('close-active')).toBeTruthy();
    expect(screen.findHostByTestId('agent-background')).toBeTruthy();
  });

  it('identifies each tab in its action names and preserves pin, unpin and unsaved close intent', async () => {
    const pin = vi.fn();
    const unpin = vi.fn();
    const close = vi.fn();
    const screen = await renderScreen(
      <DocumentTabStrip
        tabs={[
          { key: 'a', title: 'Alpha', isPinned: false, isPreview: true },
          { key: 'b', title: 'Beta', isPinned: true, isPreview: false },
        ]}
        activeTabKey="a"
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={pin}
        onUnpin={unpin}
        onClose={close}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => `tab-${id}`}
        panelNativeId={(id) => `panel-${id}`}
        unsavedTabKeys={new Set(['b'])}
        testIds={{
          tabPin: (id) => `pin-${id}`,
          tabUnpin: (id) => `unpin-${id}`,
          tabClose: (id) => `close-${id}`,
        }}
      />,
    );
    const pinButton = screen.findByTestId('pin-a');
    const unpinButton = screen.findByTestId('unpin-b');
    const closeButton = screen.findByTestId('close-b');
    expect(pinButton?.props.accessibilityLabel).toContain('Alpha');
    expect(unpinButton?.props.accessibilityLabel).toContain('Beta');
    expect(closeButton?.props.accessibilityLabel).toContain('Beta');
    expect(closeButton?.props.accessibilityLabel).toContain(
      'closeUnsavedTabA11y',
    );
    await act(async () => {
      pinButton?.props.onPress({ stopPropagation() {} });
      unpinButton?.props.onPress({ stopPropagation() {} });
      closeButton?.props.onPress({ stopPropagation() {} });
    });
    expect(pin).toHaveBeenCalledWith('a');
    expect(unpin).toHaveBeenCalledWith('b');
    expect(close).toHaveBeenCalledWith('b');
  });

  it('draws the tab actions and the tab at their design size under a finger and reaches the platform target by hit area', async () => {
    const { HappierUiPlatformProvider } =
      await import('@happier-dev/plugin-ui/environment');
    const { readHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
    const screen = await renderScreen(
      <HappierUiPlatformProvider
        platform={{ platform: 'ios', colorScheme: 'light' }}
      >
        <DocumentTabStrip
          tabs={[
            { key: 'a', title: 'Alpha', isPinned: false, isPreview: true },
          ]}
          activeTabKey="a"
          accessibilityLabel="Documents"
          onActivate={() => {}}
          onPin={() => {}}
          onUnpin={() => {}}
          onClose={() => {}}
          renderLeadingIcon={() => null}
          tabNativeId={(id) => `tab-${id}`}
          panelNativeId={(id) => `panel-${id}`}
          testIds={{
            tab: (id) => `tab-${id}`,
            tabPin: (id) => `pin-${id}`,
            tabClose: (id) => `close-${id}`,
          }}
        />
      </HappierUiPlatformProvider>,
    );
    for (const id of ['pin-a', 'close-a']) {
      const control = screen.findByTestId(id)!;
      const drawn = { width: 24, height: 24 };
      await act(async () => {
        control.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, ...drawn } },
        });
      });
      const area = readHitArea(screen.findByTestId(id)!, drawn);
      expect(area.drawn, `${id} drawn`).toEqual(drawn);
      expect(area.height, `${id} hit`).toBeGreaterThanOrEqual(44);
    }
    // The tab itself keeps its designed height: no finger floor sits in its style.
    const tabStyle = StyleSheet.flatten(
      screen.findByTestId('tab-a')!.props.style,
    ) as { minHeight?: number; minWidth?: number };
    expect(tabStyle.minHeight).toBeLessThan(44);
    expect(tabStyle.minWidth ?? 0).toBeLessThan(44);
  });

  // The Details tab's pin and close are 24 px controls flush against each other (gap 0): unbounded, each reaches
  // 10 px sideways, so a finger on the pin lands on the close, and the pin reaches into the tab's own press area.
  it('keeps the Details tab pin and close out of each other and out of the tab press area', async () => {
    const { HappierUiPlatformProvider } =
      await import('@happier-dev/plugin-ui/environment');
    const { readHitArea, hitAreaOverlap } = await import('@/dev/testkit/harness/hitFrameReach');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <DocumentTabStrip
          tabs={[{ key: 'a', title: 'Alpha', isPinned: false, isPreview: true }]}
          activeTabKey="a"
          accessibilityLabel="Documents"
          onActivate={() => {}}
          onPin={() => {}}
          onUnpin={() => {}}
          onClose={() => {}}
          renderLeadingIcon={() => null}
          tabNativeId={(id) => `tab-${id}`}
          panelNativeId={(id) => `panel-${id}`}
          testIds={{ tab: (id) => `tab-${id}`, tabPin: (id) => `pin-${id}`, tabClose: (id) => `close-${id}` }}
        />
      </HappierUiPlatformProvider>,
    );
    const drawn = { width: 24, height: 24 };
    const pin = readHitArea(screen.findByTestId('pin-a')!, drawn);
    const close = readHitArea(screen.findByTestId('close-a')!, drawn);
    expect(hitAreaOverlap(pin, close, { axis: 'horizontal', gap: 0 })).toBe(0);
    expect(pin.insets.left).toBe(0);
  });

  it('keeps a scrolling tab and its close inside the scroll viewport: the finger reach stops at the tab edge', async () => {
    const { HappierUiPlatformProvider } =
      await import('@happier-dev/plugin-ui/environment');
    const { readHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
    for (const variant of ['rail', 'bar'] as const) {
      const screen = await renderScreen(
        <HappierUiPlatformProvider
          platform={{ platform: 'ios', colorScheme: 'light' }}
        >
          <DocumentTabStrip
            variant={variant}
            tabs={[
              { key: 'a', title: 'Alpha', isPinned: false, isPreview: false },
              { key: 'b', title: 'Beta', isPinned: false, isPreview: false },
            ]}
            activeTabKey="a"
            accessibilityLabel="Documents"
            onActivate={() => {}}
            onPin={() => {}}
            onUnpin={() => {}}
            onClose={() => {}}
            renderLeadingIcon={() => null}
            tabNativeId={(id) => `tab-${id}`}
            panelNativeId={(id) => `panel-${id}`}
            testIds={{
              tab: (id) => `tab-${id}`,
              tabClose: (id) => `close-${id}`,
            }}
          />
        </HappierUiPlatformProvider>,
      );
      // The scroll viewport is exactly one tab tall (30): a reach past the tab is clipped by it.
      const tabDrawn = { width: 120, height: 30 };
      const closeDrawn = { width: 18, height: 18 };
      const tab = screen.findByTestId('tab-a')!;
      const close = screen.findByTestId('close-a')!;
      await act(async () => {
        tab.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, ...tabDrawn } },
        });
        close.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, ...closeDrawn } },
        });
      });
      const tabArea = readHitArea(screen.findByTestId('tab-a')!, tabDrawn);
      const closeArea = readHitArea(
        screen.findByTestId('close-a')!,
        closeDrawn,
      );
      expect(tabArea.insets, `${variant} tab`).toMatchObject({
        top: 0,
        bottom: 0,
      });
      const inset = (tabDrawn.height - closeDrawn.height) / 2;
      expect(closeArea.insets.top, `${variant} close top`).toBeLessThanOrEqual(
        inset,
      );
      expect(
        closeArea.insets.bottom,
        `${variant} close bottom`,
      ).toBeLessThanOrEqual(inset);
      // The drawn 18 px close still meets the 24 px pointer floor across (WCAG 2.5.8): its end padding
      // and a sliver of its own tab, never the next control.
      expect(
        closeArea.width,
        `${variant} close width`,
      ).toBeGreaterThanOrEqual(24);
      expect(closeArea.insets.right, `${variant} close trailing`).toBeLessThanOrEqual(5);
    }
  });

  it('keeps pinned tabs fixed ahead of one scrolling strip of every other tab and scrolls the open tab into view', async () => {
    const keys = ['pin', 'a', 'b', 'c', 'd', 'e', 'f'];
    const scrollTo = vi.fn();
    const strip = (active: string) => (
      <DocumentTabStrip
        variant="bar"
        tabs={keys.map((key) => ({
          key,
          title: `Tab ${key}`,
          isPinned: key === 'pin',
          isPreview: false,
        }))}
        activeTabKey={active}
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        testIds={{ tab: (id) => `tab-${id}` }}
      />
    );
    const screen = await renderScreen(strip('a'), {
      createNodeMock: (element) =>
        isHostScrollView(element.type) ? { scrollTo } : null,
    });
    const scroller = screen.root.findAll((node) => isHostScrollView(node.type));
    expect(scroller).toHaveLength(1);
    const inScroller = (key: string) =>
      scroller[0]!.findAll((node) => node.props?.testID === `tab-${key}`)
        .length > 0;
    // Every unpinned tab stays in the strip (nothing is truncated behind a count); the pinned one leads outside it.
    expect(keys.filter(inScroller)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(screen.findAllByTestId('tab-pin').length).toBeGreaterThan(0);
    // Measured: a 300 px viewport over six 120 px tabs.
    await act(async () => {
      scroller[0]!.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 30 } },
      });
      for (const [index, key] of keys.slice(1).entries()) {
        screen
          .findByTestId(`document-tab-frame-${key}`)
          ?.props.onLayout?.({
            nativeEvent: {
              layout: { x: index * 122, y: 0, width: 120, height: 30 },
            },
          });
      }
    });
    scrollTo.mockClear();
    await screen.update(strip('f'));
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 5 * 122 + 120 - 300 + 12 }),
    );
  });

  it('keeps the open rail tab in view from the live tab positions, not a stale measured layout', async () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    const scrollTo = vi.fn();
    const strip = (active: string) => (
      <DocumentTabStrip
        variant="rail"
        tabs={keys.map((key) => ({
          key,
          title: `Tab ${key}`,
          isPinned: false,
          isPreview: false,
        }))}
        activeTabKey={active}
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        testIds={{ tab: (id) => `tab-${id}` }}
      />
    );
    // The platform's live positions: six 120 px tabs. The layout events below report none of them.
    const screen = await renderScreen(strip('a'), {
      createNodeMock: (element) => {
        if (isHostScrollView(element.type)) return { scrollTo };
        const frame = /^document-tab-frame-(.+)$/.exec(
          String(element.props?.testID ?? ''),
        )?.[1];
        return frame
          ? { offsetLeft: keys.indexOf(frame) * 122, offsetWidth: 120 }
          : null;
      },
    });
    const scroller = screen.root.findAll((node) =>
      isHostScrollView(node.type),
    )[0]!;
    await act(async () => {
      scroller.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 30 } },
      });
    });
    scrollTo.mockClear();
    await screen.update(strip('f'));
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 5 * 122 + 120 - 300 + 12 }),
    );
    // Tabs arriving beside the open one resize the content without a layout event of the open tab's own.
    scrollTo.mockClear();
    await act(async () => {
      scroller.props.onContentSizeChange?.(6 * 122, 30);
    });
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ x: 5 * 122 + 120 - 300 + 12 }),
    );
  });

  it('takes a carried item only at a tab inside the visible strip, never at one scrolled out of view', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    runtime.registerSource({
      id: 'row',
      scope,
      isCurrent: () => true,
      getItem: () => ({ kind: 'destination', scope, href: '/inbox' }),
    });
    // Window geometry is the platform's: the strip shows 0–100; tab b lies at 200–260, past its clip.
    const rects: Record<
      string,
      { x: number; y: number; width: number; height: number }
    > = {
      'document-tab-viewport': { x: 0, y: 0, width: 100, height: 30 },
      'document-tab-entity-a': { x: 0, y: 0, width: 60, height: 30 },
      'document-tab-entity-b': { x: 200, y: 0, width: 60, height: 30 },
    };
    const screen = await renderScreen(
      <DocumentTabStrip
        variant="bar"
        tabs={['a', 'b'].map((key) => ({
          key,
          title: key,
          isPinned: false,
          isPreview: false,
        }))}
        activeTabKey="a"
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        testIds={{ tab: (id) => `tab-${id}` }}
        entityDragDrop={{
          runtime,
          id: 'strip',
          scope,
          acceptedKinds: ['destination'],
          getItem: () => null,
          resolve: ({ beforeTabId }) => ({
            status: 'allowed',
            effect: {
              actionId: 'workspace.tabs.open',
              input: { href: '/inbox', beforeTabId },
              preview: { verb: 'Open', target: String(beforeTabId) },
            },
          }),
          execute: async () => ({ status: 'applied' }),
        }}
      />,
      {
        createNodeMock: (element) => {
          const rect = rects[String(element.props?.testID ?? '')];
          return rect ? { getBoundingClientRect: () => rect } : null;
        },
      },
    );
    const carry = runtime.begin('row', 'pointer');
    await act(async () => {
      carry?.move({ x: 230, y: 10 });
    });
    expect(runtime.getSnapshot().targetId).toBeNull();
    await act(async () => {
      carry?.move({ x: 30, y: 10 });
    });
    expect(runtime.getSnapshot().targetId).not.toBeNull();
    act(() => carry?.cancel());
    await screen.unmount();
  });

  it("shows a tab's live status in its trailing slot and keeps close on the open tab without one (terminal lab B1)", async () => {
    const screen = await renderScreen(
      <DocumentTabStrip
        variant="bar"
        tabs={[
          { key: 'zsh', title: 'zsh', isPinned: false, isPreview: false },
          { key: 'vite', title: 'vite', isPinned: false, isPreview: false },
          { key: 'claude', title: 'Claude', isPinned: false, isPreview: false },
        ]}
        activeTabKey="zsh"
        accessibilityLabel="Terminals"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => `tab-${id}`}
        panelNativeId={(id) => `panel-${id}`}
        resolveTabPresentation={(tab) =>
          tab.key === 'vite'
            ? { status: { tone: 'running', label: 'Running' } }
            : tab.key === 'claude'
              ? { status: { tone: 'attention', label: 'Needs you' } }
              : null
        }
        testIds={{
          tab: (id) => `tab-${id}`,
          tabClose: (id) => `close-${id}`,
          tabStatus: (id) => `status-${id}`,
        }}
      />,
    );
    expect(screen.findByTestId('close-zsh')).toBeTruthy();
    expect(screen.findByTestId('status-zsh')).toBeFalsy();
    expect(screen.findByTestId('status-vite')).toBeTruthy();
    expect(screen.findByTestId('close-vite')).toBeFalsy();
    expect(
      screen.findByTestId('tab-claude')?.props.accessibilityLabel,
    ).toContain('Needs you');
  });
  it('mounts only the bar tabs near the viewport plus the open tab, and keeps the scroll extent for the rest', async () => {
    const keys = Array.from({ length: 393 }, (_, index) => `t${index}`);
    const scrollTo = vi.fn();
    const strip = (active: string) => (
      <DocumentTabStrip
        variant="bar"
        tabs={keys.map((key) => ({ key, title: `Tab ${key}`, isPinned: false, isPreview: false }))}
        activeTabKey={active}
        accessibilityLabel="Documents"
        onActivate={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
        onClose={() => {}}
        renderLeadingIcon={() => null}
        tabNativeId={(id) => id}
        panelNativeId={(id) => id}
        testIds={{ tab: (id) => `tab-${id}` }}
      />
    );
    const screen = await renderScreen(strip('t0'), {
      createNodeMock: (element) => (isHostScrollView(element.type) ? { scrollTo } : null),
    });
    const scroller = screen.root.findAll((node) => isHostScrollView(node.type))[0]!;
    const mounted = () => keys.filter((key) => screen.findAllByTestId(`tab-${key}`).length > 0);
    await act(async () => {
      scroller.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 30 } } });
    });
    // A 1200 px strip shows about nine 144 px tabs; the rest wait behind spacers.
    expect(mounted().length).toBeLessThan(30);
    expect(mounted()).toContain('t0');
    const minWidth = (node: { props: { contentContainerStyle?: unknown } }) =>
      StyleSheet.flatten(node.props.contentContainerStyle as StyleProp<ViewStyle>)?.minWidth;
    expect(minWidth(scroller)).toBe(393 * 146 + 2);
    // Scrolling far brings that region in; the open tab stays mounted wherever the strip is.
    await act(async () => {
      scroller.props.onScroll?.({ nativeEvent: { contentOffset: { x: 200 * 146, y: 0 }, contentSize: { width: 393 * 146, height: 30 }, layoutMeasurement: { width: 1200, height: 30 } } });
    });
    expect(mounted().length).toBeLessThan(40);
    expect(mounted()).toEqual(expect.arrayContaining(['t0', 't200', 't205']));
    expect(mounted()).not.toContain('t100');
    await screen.unmount();
  });
});
