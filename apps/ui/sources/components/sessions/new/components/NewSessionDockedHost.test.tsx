import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';

const boundary = vi.hoisted(() => ({
  width: 1440,
  pathname: '/',
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: boundary.width,
      height: 900,
      scale: 1,
      fontScale: 1,
    }),
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({
    settleTimingCallbacks: true,
  }),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      router: { push: boundary.push, replace: boundary.replace },
      // The route the shell is on: a navigation changes it and the shell renders the new screen.
      pathname: () => boundary.pathname,
    }).module,
);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@react-native-masked-view/masked-view', () => ({
  default: 'MaskedView',
}));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

const account = createProviderSettingsAccountHarness();
await (
  await import('@/dev/testkit/harness/syncSingletonLoader')
).loadSyncSingletonForTests();
const { NewSessionDockedHost } = await import('./NewSessionDockedHost');
const {
  NewSessionShellHostProvider,
  useNewSessionShellHost,
  useOpenNewSession,
} = await import('../navigation/newSessionEntry');
const { IconButton } = await import('@/components/ui/buttons/IconButton');
const { getStorage } = await import('@/sync/domains/state/storage');
const { PAGE_LIST_METRICS } =
  await import('@/components/ui/lists/pageListMetrics');
const { COMPOSER_CONTENT_HORIZONTAL_INSET } =
  await import('@/components/sessions/agentInput/composerContentInset');
const { layout } = await import('@/components/ui/layout/layout');
const { Pressable } = await import('react-native');
const { NavigationContext } = await import('@react-navigation/native');
const { HeaderHeightContext } = await import('@react-navigation/elements');
const { readComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const {
  SessionCockpitChromeRegistryProvider,
  useSessionCockpitBottomChromeHeightSetter,
  useSessionCockpitPageBottomClearance,
} = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');

/** The phone's tab bar under the page, and the page's read of how far floating chrome covers its bottom. */
function PhoneBarAndPage(props: Readonly<{ bar: number }>) {
  const setBar = useSessionCockpitBottomChromeHeightSetter();
  React.useLayoutEffect(() => setBar(props.bar), [props.bar, setBar]);
  return React.createElement('PageClearance', { value: useSessionCockpitPageBottomClearance() });
}

/** The entry owner every New entry (Alt+N, palette, sidebar button) goes through. */
function Entry() {
  const open = useOpenNewSession();
  const shell = useNewSessionShellHost();
  return (
    <>
      <Pressable testID="open-dock" onPress={() => open()} />
      <Pressable testID="close-dock" onPress={shell?.close} />
      <Pressable testID="hand-off-created" onPress={() => shell?.host.onHandedOff('/session/s-created')} />
      {React.createElement('DockState', {
        visible: shell?.visible,
        draftId: shell?.host.params.draftId,
      })}
    </>
  );
}

function Journey() {
  return (
    <NavigationContext.Provider value={createNavigationPropMock()}>
      <HeaderHeightContext.Provider value={0}>
        <NewSessionShellHostProvider>
          <Entry />
          <NewSessionDockedHost>
            <Pressable testID="page" />
          </NewSessionDockedHost>
        </NewSessionShellHostProvider>
      </HeaderHeightContext.Provider>
    </NavigationContext.Provider>
  );
}

async function openDockedDraft(text: string, presentation: { newSessionPresentationModeV1?: 'docked' } = { newSessionPresentationModeV1: 'docked' }) {
  await account.restore({
    settings: { ...presentation, glassPreset: 'solid' },
  });
  const screen = await renderScreen(<Journey />);
  await screen.pressByTestIdAsync('open-dock');
  const input = () =>
    screen.tree.root
      .findAllByProps({ testID: 'new-session-composer-input' })
      .find((node) => typeof node.props.onChangeText === 'function' && typeof node.props.value === 'string');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(input()).toBeDefined();
  });
  await act(async () => input()!.props.onChangeText(text));
  const state = () =>
    screen.tree.root.findByType('DockState' as never).props as {
      visible: boolean;
      draftId: string;
    };
  return { screen, input, state };
}

/** The shell's resizable pane, found by the props it is driven through (its release and reset). */
const resizePanes = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen.tree.root.findAll((node) => typeof node.props.onCommitWidthPx === 'function' && node.props.testID === 'new-session-docked-resize');

const iconButton = (
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) =>
  screen.tree.root.findAll(
    (node) => node.type === IconButton && node.props.testID === testID,
  );

describe('web shell Docked composer', () => {
  beforeAll(async () => {
    await import('../NewSessionScreen');
  });
  afterEach(async () => {
    standardCleanup();
    await account.reset();
    boundary.width = 1440;
    boundary.pathname = '/';
    getStorage()
      .getState()
      .applyLocalSettings(
        { newSessionDockedWidthPx: null },
        { source: 'ui' },
      );
  });

  it('carries its draft actions and its way out as quiet icon buttons on the status row', async () => {
    const { screen } = await openDockedDraft('Refactor the billing retry loop');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        iconButton(screen, 'new-session-draft-start-another'),
      ).toHaveLength(1);
    });
    for (const testID of [
      'new-session-draft-start-another',
      'new-session-draft-delete',
      'new-session-docked-collapse',
      'new-session-composer-close',
    ]) {
      const [button] = iconButton(screen, testID);
      expect(button, testID).toBeDefined();
      expect(button!.props.accessibilityLabel, testID).toBeTruthy();
      expect(button!.props.tooltip, testID).toBe(
        button!.props.accessibilityLabel,
      );
    }
    await act(async () => screen.unmount());
  });

  it('seats those actions in a header row that names the draft, like a Session composer names its state', async () => {
    const { screen } = await openDockedDraft('Refactor the billing retry loop');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(iconButton(screen, 'new-session-composer-close')).toHaveLength(1);
    });
    const lead = screen.tree.root.findAll((node) => node.props.testID === 'agent-input-connection-status-text' && typeof node.type === 'string');
    const { t } = await import('@/text');
    expect(lead.map((node) => node.props.children).flat()).toContain(t('sessionDrafts.new.action'));
    await act(async () => screen.unmount());
  });

  it('collapses to a pill in its seat and restores the same draft through the entry owner', async () => {
    const { screen, input, state } = await openDockedDraft(
      'Keep this docked draft',
    );
    const draftId = state().draftId;
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(iconButton(screen, 'new-session-docked-collapse')).toHaveLength(1);
    });
    await act(async () =>
      iconButton(screen, 'new-session-docked-collapse')[0]!.props.onPress(),
    );
    expect(screen.findAllHostsByTestId('new-session-docked-host')).toHaveLength(
      0,
    );
    expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(
      1,
    );
    await vi.waitFor(() =>
      expect(
        screen.findAllHostsByTestId('new-session-docked-pill-dot'),
      ).toHaveLength(1),
    );
    expect(state().visible).toBe(true);

    // Alt+N, the palette and the sidebar button share this entry: it restores rather than starting over.
    await screen.pressByTestIdAsync('open-dock');
    expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(
      0,
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(input()?.props.value).toBe('Keep this docked draft');
    });
    expect(state().draftId).toBe(draftId);

    await act(async () =>
      iconButton(screen, 'new-session-docked-collapse')[0]!.props.onPress(),
    );
    await screen.pressByTestIdAsync('new-session-docked-pill');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(input()?.props.value).toBe('Keep this docked draft');
    });
    expect(state().draftId).toBe(draftId);

    await act(async () =>
      iconButton(screen, 'new-session-docked-collapse')[0]!.props.onPress(),
    );
    await screen.pressByTestIdAsync('close-dock');
    expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(
      0,
    );
    await screen.pressByTestIdAsync('open-dock');
    expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(
      0,
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(input()?.props.value).toBe('Keep this docked draft');
    });
    await act(async () => screen.unmount());
  });

  it('folds to its pill when Open takes the person to the Session it started, uncovering that Session composer', async () => {
    const { screen, state } = await openDockedDraft('Start this in the dock');
    boundary.push.mockClear();
    // Send hands the draft to the created Session in place; the dock offers Open on its status row.
    await screen.pressByTestIdAsync('hand-off-created');
    const open = () => screen.tree.root.findAll((node) => node.props.testID === 'new-session-docked-open' && typeof node.props.onPress === 'function');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(open().length).toBeGreaterThan(0);
    });
    await act(async () => open()[0]!.props.onPress());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(1);
    });
    expect(boundary.push.mock.calls.map((call) => call[0])).toContain('/session/s-created');
    expect(screen.findAllHostsByTestId('new-session-docked-host')).toHaveLength(0);
    expect(state().visible).toBe(true);
    await act(async () => screen.unmount());
  });

  it('keeps saying the Session started once it has a title, with one Open to watch it (J-SESSION UX1)', async () => {
    const { screen } = await openDockedDraft('Fix the billing retry');
    await screen.pressByTestIdAsync('hand-off-created');
    const { t } = await import('@/text');
    const { createSessionFixture } = await import('@/dev/testkit');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    await act(async () => {
      getStorage().getState().applySessions([createSessionFixture({
        id: 's-created',
        serverId: getActiveServerSnapshot().serverId,
        metadata: { ...createSessionFixture().metadata!, summary: { text: 'Billing retry fix', updatedAt: 1 } },
      })]);
    });
    const rendered = () => JSON.stringify(screen.tree.toJSON());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(rendered()).toContain(t('sessionDrafts.startedTitled', { title: 'Billing retry fix' }));
    });
    expect(screen.tree.root.findAll((node) => node.props.testID === 'new-session-docked-open' && typeof node.props.onPress === 'function').length).toBeGreaterThan(0);
    await act(async () => screen.unmount());
  });

  it('never says Session started for a Session whose launch failed (R75)', async () => {
    const { screen } = await openDockedDraft('Start this in the dock');
    await screen.pressByTestIdAsync('hand-off-created');
    const rendered = () => JSON.stringify(screen.tree.toJSON());
    const { t } = await import('@/text');
    const started = t('session.transcriptNavigation.sessionStarted');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(rendered()).toContain(started);
    });
    // The launch owns the first message and settles it failed with its typed reason.
    await act(async () => {
      getStorage().getState().upsertPendingMessage('s-created', {
        id: 'first-turn', localId: 'first-turn', createdAt: 1, updatedAt: 2, source: 'local_outbound', text: 'Start this in the dock',
        displayText: 'Start this in the dock', rawRecord: {}, pendingLaunch: { state: 'failed', message: 'Agent startup failed.', draftId: null },
      } as never);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(rendered()).not.toContain(started);
      expect(rendered()).toContain('Agent startup failed.');
    });
    await act(async () => screen.unmount());
  });

  it('opens Docked for an Account that never chose a presentation', async () => {
    const { screen, input } = await openDockedDraft('First draft', {});
    expect(input()?.props.value).toBe('First draft');
    expect(screen.findAllHostsByTestId('new-session-docked-host').length).toBeGreaterThan(0);
    await act(async () => screen.unmount());
  });

  it('opens at the Session composer width, resizes from both edges up to the page column, keeps the width on this device and resets on request', async () => {
    const { screen } = await openDockedDraft('Wide draft');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(resizePanes(screen).length).toBeGreaterThan(0);
    });
    const pane = () => resizePanes(screen)[0]!;
    const min = PAGE_LIST_METRICS.dialogWidthPx.default;
    // The Session composer's width in this pane (the window, without a measured shell): the reading width,
    // inside the composer's own side insets.
    const composerWidth = Math.min(layout.maxWidth, 1440 - COMPOSER_CONTENT_HORIZONTAL_INSET * 2);
    // It may widen past the composer, up to the column inside the same side insets.
    const columnWidth = 1440 - COMPOSER_CONTENT_HORIZONTAL_INSET * 2;
    expect(pane().props).toMatchObject({
      resizeEdge: 'both',
      minWidthPx: min,
      widthPx: composerWidth,
      maxWidthPx: columnWidth,
    });
    await act(async () => pane().props.onCommitWidthPx(1200));
    expect(pane().props.widthPx).toBe(1200);
    await act(async () => pane().props.onCommitWidthPx(640));
    expect(getStorage().getState().localSettings.newSessionDockedWidthPx).toBe(
      640,
    );
    expect(pane().props.widthPx).toBe(640);
    // A width kept from a wider window never draws past this one.
    await act(async () => {
      getStorage()
        .getState()
        .applyLocalSettings(
          { newSessionDockedWidthPx: 5000 },
          { source: 'ui' },
        );
    });
    expect(pane().props.widthPx).toBe(columnWidth);
    await act(async () => pane().props.onResetRequest());
    expect(getStorage().getState().localSettings.newSessionDockedWidthPx).toBeNull();
    expect(pane().props.widthPx).toBe(composerWidth);
    await act(async () => screen.unmount());
  });

  it('shares dock width and reset with the agent settings Action and honors the same disabled policy', async () => {
    const { screen } = await openDockedDraft('Shared width');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent', authority: 'account_automation', serverId: account.serverId } as const;
    await act(async () => {
      const result = await executor.execute('settings.set', { anchor: 'appearance.newSessionDockedWidth', value: 640 }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    });
    expect(resizePanes(screen)[0]!.props.widthPx).toBe(640);
    await act(async () => {
      expect(await executor.execute('settings.set', { anchor: 'appearance.newSessionDockedWidth', value: null }, context)).toMatchObject({ ok: true });
    });
    expect(getStorage().getState().localSettings.newSessionDockedWidthPx).toBeNull();
    await act(async () => {
      const state = getStorage().getState();
      state.applySettings({ ...state.settings, actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui', 'agent'] } } } }, state.settingsVersion + 1);
      await resizePanes(screen)[0]!.props.onCommitWidthPx(700);
      expect(await executor.execute('settings.set', { anchor: 'appearance.newSessionDockedWidth', value: 700 }, context)).toMatchObject({ ok: false });
    });
    expect(getStorage().getState().localSettings.newSessionDockedWidthPx).toBeNull();
    await act(async () => screen.unmount());
  });

  it('keeps the exact composer and its open-surface lifetime current across desktop and phone widths', async () => {
    const { NewSessionComposerCard } = await import('./NewSessionComposerCard');
    const { screen, state } = await openDockedDraft('Unsent café é 👩🏽‍💻 日本語');
    const document = () => screen.tree.root.findByType(NewSessionComposerCard).props.panelProps.composerDocument!;
    const original = document();
    const before = original.readCurrentDocumentSnapshot();
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftSnapshot = () => getSessionDraftSnapshot(getStorage().getState().settingsScope!, { kind: 'newSession', draftId: state().draftId });
    expect(before).not.toBeNull();
    expect(original.scopeSignal?.aborted).toBe(false);
    try {
      for (const width of [390, 360, 1440]) {
        boundary.width = width;
        await screen.update(<Journey />);
        // 1b0d4ec4c0f projects repository revision: authoring autosave can advance it
        // without changing Composer content or retiring its mounted lifetime.
        const currentDraft = draftSnapshot();
        expect(currentDraft).not.toBeNull();
        expect.soft(original.scopeSignal?.aborted, 'resizing must not retire an open Composer dialog').toBe(false);
        expect.soft(original.readCurrentDocumentSnapshot(), 'the original mounted document must stay current').toMatchObject({
          ref: before!.ref, revision: currentDraft!.revision, text: before!.text,
        });
        expect.soft(document().readCurrentDocumentSnapshot()).toMatchObject({
          ref: before!.ref, revision: currentDraft!.revision, text: before!.text,
        });
      }
    } finally {
      await screen.unmount();
    }
  });

  it('keeps the phone-width dock full width, without a resize edge or collapse', async () => {
    boundary.width = 390;
    const { screen } = await openDockedDraft('Phone draft');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        screen.findAllHostsByTestId('new-session-composer-close').length,
      ).toBeGreaterThan(0);
    });
    expect(screen.findAllHostsByTestId('new-session-docked-resize-resize-left')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('new-session-docked-resize-resize-right')).toHaveLength(0);
    expect(iconButton(screen, 'new-session-docked-collapse')).toHaveLength(0);
    await act(async () => screen.unmount());
  });

  it('lets a fresh detail host read the retained draft after navigation and closes reads on retirement', async () => {
    const { createComposerPresentationHostHandlers } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    const { createPluginSurfaceHostApi } = await import('@/components/plugins/surfaces/createPluginSurfaceHostApi');
    const { screen, state } = await openDockedDraft('Unsent café 日本語');
    const ref = { kind: 'newSession' as const, instanceId: state().draftId };
    const surface = { pluginId: 'acme.fixture', contributionId: 'details', surfaceId: 'fresh-details',
      placement: 'appSurface' as const, platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
    const request = { version: 1 as const, requestId: 'composer-scope-read', surface, method: 'readComposer' as const, payload: { ref } };
    boundary.pathname = '/plugins/happier.triage/triage/e,pr,54';
    await screen.update(<Journey />);
    const handlers = createComposerPresentationHostHandlers({ scope: getStorage().getState().settingsScope!, mountedComposer: ref,
      owner: { identity: { pluginId: 'acme.fixture', localId: 'details' }, occurrenceId: 'fresh', surfaceInstanceKey: 'fresh-details' } });
    const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers });
    try {
      for (const width of [1440, 390, 360, 1440]) {
        boundary.width = width;
        await screen.update(<Journey />);
        expect(await api.handleRequest(request)).toMatchObject({ status: 'ready', snapshot: { ref, text: 'Unsent café 日本語' } });
      }
      await screen.pressByTestIdAsync('close-dock');
      expect(await api.handleRequest(request)).toEqual({ status: 'unavailable', reason: 'scopeClosed', requestId: request.requestId });
    } finally {
      handlers.dispose();
      await screen.unmount();
    }
  });

  it('stays with the screen that opened it: another screen hides it and its draft comes back on return', async () => {
    boundary.width = 390;
    boundary.pathname = '/actions';
    const { screen, input, state } = await openDockedDraft('Phone draft');
    const draftId = state().draftId;
    // Actions -> PRs & Issues -> PR #4 View details: the dock must not cover that screen's controls.
    boundary.pathname = '/plugins/happier.triage/triage/e,pr,4';
    await screen.update(<Journey />);
    await act(async () => {});
    // Hidden, not retired: nothing on this screen is covered or reachable through it, and its composer document
    // stays registered, so a picker that opened from it (Triage's entry picker) still reads it by its exact ref.
    const retained = () => screen.findAllHostsByTestId('new-session-docked-retained')[0];
    expect(retained()?.props.pointerEvents).toBe('none');
    expect(readComposerPresentationTarget({ kind: 'newSession', instanceId: draftId })).not.toBeNull();
    boundary.pathname = '/actions';
    await screen.update(<Journey />);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(retained()?.props.pointerEvents).not.toBe('none');
    });
    expect(state().draftId).toBe(draftId);
    expect(input()!.props.value).toBe('Phone draft');
    await act(async () => screen.unmount());
  });

  it('gives the page under a shown desktop dock a bottom inset as tall as the dock, with no bar under it', async () => {
    await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
    const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><Journey /><PhoneBarAndPage bar={0} /></SessionCockpitChromeRegistryProvider>);
    const clearance = () => (screen.tree.root.findByType('PageClearance' as never).props as { value: number }).value;
    expect(clearance()).toBe(0);
    await screen.pressByTestIdAsync('open-dock');
    const dock = () => screen.tree.root.findAll((node) => node.props.testID === 'new-session-docked-host' && typeof node.props.onLayout === 'function');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(dock().length).toBeGreaterThan(0);
    });
    await act(async () => dock()[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 720, height: 200 } } }));
    expect(clearance()).toBeGreaterThanOrEqual(200);
    await screen.pressByTestIdAsync('close-dock');
    await act(async () => {});
    expect(clearance()).toBe(0);
    await act(async () => screen.unmount());
  });

  it('seats a desktop dock with half the bottom margin a Session composer keeps (owner 11-08)', async () => {
    const { resolveSessionViewContentBottomSpacing, SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX } =
      await import('@/components/sessions/shell/view/resolveSessionViewContentBottomSpacing');
    await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
    const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><Journey /><PhoneBarAndPage bar={0} /></SessionCockpitChromeRegistryProvider>);
    const clearance = () => (screen.tree.root.findByType('PageClearance' as never).props as { value: number }).value;
    await screen.pressByTestIdAsync('open-dock');
    const dock = () => screen.tree.root.findAll((node) => node.props.testID === 'new-session-docked-host' && typeof node.props.onLayout === 'function');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(dock().length).toBeGreaterThan(0);
    });
    await act(async () => dock()[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 720, height: 200 } } }));
    // The visible margin under a composer card: the gap below it plus the composer's own bottom padding.
    const sessionMargin = resolveSessionViewContentBottomSpacing({ chatBottomSpacing: 'default', safeAreaBottomPx: 0,
      availableWidthPx: boundary.width, contentMaxWidthPx: layout.maxWidth }) + SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX;
    const dockMargin = clearance() - 200 + SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX;
    expect(dockMargin).toBe(sessionMargin / 2);
    await act(async () => screen.unmount());
  });

  it('takes the Session composer seat on a phone while shown, so one composer is on screen (L11)', async () => {
    const { useNewSessionDockHoldsComposerSeat } = await import('../navigation/newSessionEntry');
    function SessionComposerSeat() {
      return useNewSessionDockHoldsComposerSeat() ? null : React.createElement('SessionComposer');
    }
    const sessionComposers = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.tree.root.findAllByType('SessionComposer' as never).length;
    boundary.width = 390;
    // The page's own composer reads the same shell as the dock.
    await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
    const page = await renderScreen(<NavigationContext.Provider value={createNavigationPropMock()}><HeaderHeightContext.Provider value={0}>
      <NewSessionShellHostProvider><Entry /><NewSessionDockedHost><SessionComposerSeat /></NewSessionDockedHost></NewSessionShellHostProvider>
    </HeaderHeightContext.Provider></NavigationContext.Provider>);
    expect(sessionComposers(page)).toBe(1);
    await page.pressByTestIdAsync('open-dock');
    await act(async () => {});
    expect(sessionComposers(page)).toBe(0);
    await page.pressByTestIdAsync('close-dock');
    await act(async () => {});
    expect(sessionComposers(page)).toBe(1);
    await act(async () => page.unmount());
    // A desktop dock stands in its own seat under the Session composer, which stays.
    boundary.width = 1440;
    const desk = await renderScreen(<NavigationContext.Provider value={createNavigationPropMock()}><HeaderHeightContext.Provider value={0}>
      <NewSessionShellHostProvider><Entry /><NewSessionDockedHost><SessionComposerSeat /></NewSessionDockedHost></NewSessionShellHostProvider>
    </HeaderHeightContext.Provider></NavigationContext.Provider>);
    await desk.pressByTestIdAsync('open-dock');
    await act(async () => {});
    expect(sessionComposers(desk)).toBe(1);
    await act(async () => desk.unmount());
  });

  it('gives the page under a shown phone dock a bottom inset as tall as the dock', async () => {
    boundary.width = 390;
    await account.restore({ settings: { newSessionPresentationModeV1: 'docked', glassPreset: 'solid' } });
    const tree = () => <SessionCockpitChromeRegistryProvider><Journey /><PhoneBarAndPage bar={60} /></SessionCockpitChromeRegistryProvider>;
    const screen = await renderScreen(tree());
    const clearance = () => (screen.tree.root.findByType('PageClearance' as never).props as { value: number }).value;
    expect(clearance()).toBe(60);
    await screen.pressByTestIdAsync('open-dock');
    const dock = () => screen.tree.root.findAll((node) => node.props.testID === 'new-session-docked-host' && typeof node.props.onLayout === 'function');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(dock().length).toBeGreaterThan(0);
    });
    await act(async () => dock()[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 180 } } }));
    // The bar, the dock and the gap between them: nothing under the dock is out of reach.
    expect(clearance()).toBeGreaterThanOrEqual(60 + 180);
    await screen.pressByTestIdAsync('close-dock');
    await act(async () => {});
    expect(clearance()).toBe(60);
    await act(async () => screen.unmount());
  });

  it('names a Bot draft in both the open instrument strip and its folded dock', async () => {
    const { screen, state } = await openDockedDraft('Make a helpful Bot');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const { NEW_BOT_SEED } = await import('@/components/sessions/bots/newBotDraft');
    const { t } = await import('@/text');
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the restored Account scope');
    await act(async () => { writeNewSessionDraft({ scope, draftId: state().draftId, materializationIntent: 'seeded', patch: { authoring: NEW_BOT_SEED } }); });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('bots.new')));
    expect(screen.getTextContent()).not.toContain(t('sessionDrafts.new.action'));
    await act(async () => iconButton(screen, 'new-session-docked-collapse')[0]!.props.onPress());
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('new-session-docked-pill')).toHaveLength(1));
    expect(screen.findAllHostsByTestId('new-session-docked-pill')[0]!.props.accessibilityLabel).toBe(t('bots.new'));
    expect(screen.getTextContent()).toContain(t('bots.new'));
    // QA-RERUN-1113 F5: deleting it names a bot draft, through the same draft identity.
    const { presentActionApproval } = await import('@/components/approvals/actionApprovalPresentation');
    const confirm = presentActionApproval({ actionId: 'session.draft.delete', actionArgs: { draftId: state().draftId }, kind: 'confirmation' });
    expect(confirm.title).toContain(t('sessionDrafts.botActionTitles.delete'));
    // F6 (UI refinements ruling): a named draft folds to its name; "New bot" shows only until it has one.
    await act(async () => { writeNewSessionDraft({ scope, draftId: state().draftId, materializationIntent: 'seeded', patch: { authoring: { sessionName: 'Nightly build watcher' } } }); });
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('new-session-docked-pill')[0]!.props.accessibilityLabel).toBe('Nightly build watcher'));
    expect(presentActionApproval({ actionId: 'session.draft.delete', actionArgs: { draftId: state().draftId }, kind: 'confirmation' }).title)
      .toContain('Nightly build watcher');
    // COPY-NOUN-HUNT-1113: every draft Action names the Bot draft through the same identity, not just Delete.
    expect(presentActionApproval({ actionId: 'session.draft.open', actionArgs: { draftId: state().draftId } }).title)
      .toContain(t('sessionDrafts.botActionTitles.open'));
    await screen.unmount();
  });

});
