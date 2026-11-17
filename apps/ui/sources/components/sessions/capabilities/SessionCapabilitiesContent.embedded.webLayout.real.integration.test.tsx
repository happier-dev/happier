// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const native = await import('react-native');
  const mock = createReanimatedModuleMock();
  const Animated = {
    ...mock.default,
    View: native.View,
    ScrollView: native.ScrollView,
    Text: native.Text,
  };
  return { ...mock, ...Animated, default: Animated };
});

installWebLayoutBridge();
const { ListPresentationProvider } =
  await import('@/components/ui/lists/listPresentation');
const { Item } = await import('@/components/ui/lists/Item');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const {
  WorkSection,
  WorkSectionPlacementProvider,
  WorkSectionSetupDisclosureProvider,
} = await import('@/components/sessions/work/WorkSection');
const { buildSessionCapabilitiesModel } =
  await import('./sessionCapabilitiesModel');
const { SessionCapabilitiesContent } =
  await import('./SessionCapabilitiesContent');
const { t } = await import('@/text');

/**
 * Session Info at 1440: the Skills row is 380 wide (live 1008–1388), which this page sheet gives in a 414 pane.
 * The phone: the 390 screen itself.
 */
it.each([
  { paneWidth: 414, liveRowWidth: 380 },
  { paneWidth: 390, liveRowWidth: null },
])(
  "lays an embedded state line on the host value column and the content rows' text edge (owner 11-16 F1, pane $paneWidth)",
  async ({ paneWidth, liveRowWidth }) => {
    const model = buildSessionCapabilitiesModel({
      view: null,
      state: 'machine_unreachable',
      readOnly: false,
      names: {
        machineName: () => 'qa-dev-000',
        projectName: () => 'p0',
        agentName: () => 'Claude',
        agentNames: (ids: readonly string[]) => ids.map(() => 'Claude'),
        folderLabel: () => '~/p0',
      },
      rules: () => [],
      mcpStatus: () => [],
      skillStatus: () => [],
      cost: () => ({ tokensWhenUsed: 0 }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <ListPresentationProvider value="page">
            <View testID="pane" style={{ width: paneWidth }}>
              {/* Session Info's Setup section: one page section sheet holding the Skills row and its siblings. */}
              <ItemGroup title="Setup">
                <WorkSectionPlacementProvider value="setup">
                <WorkSectionSetupDisclosureProvider
                  value={{ isExpanded: () => true, setExpanded: () => {} }}
                >
                  <WorkSection
                    testID="session-setup-skills"
                    nativeID="skills"
                    anatomy="page"
                    icon="lightbulb"
                    title="Skills"
                    count={0}
                    summary="—"
                    setupDefaultExpanded={false}
                  >
                    <SessionCapabilitiesContent
                      kind="skills"
                      presentation="embedded"
                      model={model}
                      onChange={async () => {}}
                      onRetry={() => {}}
                      onOpen={() => {}}
                      machineName="qa-dev-000"
                      testID="caps"
                    />
                  </WorkSection>
                </WorkSectionSetupDisclosureProvider>
              </WorkSectionPlacementProvider>
              {/* A sibling Setup row's trailing value: where the host's switches and chevron boxes end. */}
              <Item
                testID="sibling"
                title="Notes"
                rightElement={
                  <View
                    testID="sibling-value"
                    style={{ width: 24, height: 16 }}
                  />
                }
              />
              </ItemGroup>
            </View>
          </ListPresentationProvider>,
        ),
      );
      const offlineSentence = t('capabilities.session.sheet.offline', { machine: 'qa-dev-000' });
      const addLabel = t('capabilities.session.sheet.add');
      const layout = await measureWebLayout(host, {
        viewport: { width: 1440, height: 900 },
        texts: ['Try again', offlineSentence, addLabel],
      });
      if (liveRowWidth !== null) expect(Math.round(layout.rect('session-setup-skills:row').width)).toBe(liveRowWidth);
      const valueColumnEnd = layout.rect('sibling-value').right;
      const [tryAgain] = layout.textRects('Try again');
      expect(tryAgain).toBeDefined();
      expect(Math.round(tryAgain!.right)).toBe(Math.round(valueColumnEnd));
      // The line's sentence starts on the same edge as the content's rows (the add row's title).
      const [sentence] = layout.textRects(offlineSentence);
      const [add] = layout.textRects(addLabel);
      expect(sentence).toBeDefined();
      expect(add).toBeDefined();
      expect(Math.round(sentence!.left)).toBe(Math.round(add!.left));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
