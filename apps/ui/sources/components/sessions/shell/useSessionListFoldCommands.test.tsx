import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  CurrentUiContextProvider,
  useOptionalCurrentUiContextReader,
  usePublishCurrentUiContext,
  type CurrentUiContextReader,
} from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  collapsedGroupsState,
  useCollapsedGroupKeys,
} from '@/sync/domains/state/disclosureUiState';
import {
  buildSessionListCollapseKey,
  readSessionListCollapsedGroups,
} from '@/sync/domains/session/listing/sessionListCollapseState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: () => '/',
    segments: () => ['(app)'],
    params: () => ({}),
  }).module;
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;
afterEach(async () => {
  standardCleanup();
  unregister?.();
  unregister = undefined;
  reader = null;
  retireActiveServerAccountScopeLifetime();
  await home?.dispose();
  home = undefined;
});

function Publication() {
  reader = useOptionalCurrentUiContextReader();
  const commands = useCurrentUiContextComposedCommands();
  const enrichment = React.useMemo(() => ({ commands }), [commands]);
  usePublishCurrentUiContext(enrichment);
  React.useEffect(() => {
    if (!reader) return;
    const current = reader;
    unregister = registerCurrentUiContextActionPort((surface) =>
      createCurrentUiContextVoiceToolPort({
        reader: current,
        invocationSurface: surface,
        readProjection: () => null,
        readNavigationBinding: () => null,
      }),
    );
    return unregister;
  }, [reader]);
  return null;
}

const CONTEXT = JSON.stringify(['scope', 'active', 'projects', null]);
const items: readonly SessionListIndexItem[] = [
  {
    type: 'header',
    title: 'Happier',
    headerKind: 'project',
    groupKey: 'project:happier',
  },
  {
    type: 'header',
    title: 'Launch',
    headerKind: 'folder',
    groupKey: 'section:launch',
    folderId: 'launch',
  },
];

describe('Sessions list fold commands', () => {
  it('fold and unfold a mounted group through the same context-qualified writer, keeping other choices', async () => {
    home = await serveActionHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://session-list-fold.test',
          accountId: 'account-a',
        },
      ],
      route: (request) =>
        request.path === '/v1/kv/bulk'
          ? Response.json({ values: [] })
          : undefined,
    });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({
      serverId: server.id,
      serverUrl: server.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      server.serverUrl,
    ))!;
    const executor = (
      await import('@/sync/ops/actions/defaultActionExecutor')
    ).createDefaultActionExecutor();
    const unrelated = buildSessionListCollapseKey(
      JSON.stringify(['scope', 'archived', 'projects', null]),
      'project:happier',
    );
    replacePersistentUiStateForTest(collapsedGroupsState, {
      [unrelated]: true,
    });
    const { useSessionListFoldCommands } =
      await import('./useSessionListFoldCommands');
    // The list's own reader: the stored map projected to this context.
    function MountedList(props: Readonly<{ active: boolean }>) {
      const stored = useCollapsedGroupKeys(
        buildSessionListCollapseKey(CONTEXT, ''),
      );
      const collapsedKeys = React.useMemo(
        () => readSessionListCollapsedGroups(stored, CONTEXT),
        [stored],
      );
      useSessionListFoldCommands({
        items,
        collapsedKeys,
        projectHeaderViewModelByGroupKey: new Map(),
        collapseContextKey: CONTEXT,
        active: props.active,
      });
      return null;
    }
    const tree = (shown: boolean, active = true) => (
      <InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider>
          <AppPaneProvider>
            <CurrentUiContextProvider>
              <PluginSurfaceFocusEligibilityProvider
                active
                currentUiContextActive
              >
                <Publication />
                {shown ? <MountedList active={active} /> : null}
              </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider>
          </AppPaneProvider>
        </MainAppTabStateProvider>
      </InjectedAuthProvider>
    );
    const screen = await renderScreen(tree(true));
    const find = (verb: 'expand' | 'collapse', title: string) =>
      reader!
        .readCurrentUiContext()!
        .commands.find(
          (command) => command.title === `${t(`common.${verb}`)} · ${title}`,
        );
    const invoke = (commandId: string) =>
      executor.execute(
        'ui.current_context.command.invoke',
        { commandId },
        { surface: 'agent' },
      );

    expect(
      await executor.execute(
        'ui.current_context.read',
        {},
        { surface: 'agent' },
      ),
    ).toMatchObject({ ok: true });
    const collapseSection = find('collapse', 'Launch');
    expect(collapseSection).toBeDefined();
    expect(find('collapse', 'Happier')).toBeDefined();
    await act(async () => {
      expect(await invoke(collapseSection!.id)).toMatchObject({ ok: true });
    });
    expect(collapsedGroupsState.readAll()).toEqual({
      [unrelated]: true,
      [buildSessionListCollapseKey(CONTEXT, 'section:launch')]: true,
    });

    const expandSection = find('expand', 'Launch')!;
    expect(expandSection).toBeDefined();
    await act(async () => {
      expect(await invoke(expandSection.id)).toMatchObject({ ok: true });
    });
    expect(collapsedGroupsState.readAll()).toEqual({
      [unrelated]: true,
      [buildSessionListCollapseKey(CONTEXT, 'section:launch')]: false,
    });

    // A list that is not presented publishes nothing; an unmounted one retires its addresses.
    const retained = find('collapse', 'Launch')!;
    await screen.update(tree(true, false));
    expect(find('collapse', 'Launch')).toBeUndefined();
    await screen.update(tree(false));
    expect(await invoke(retained.id)).toMatchObject({ ok: false });
    expect(
      collapsedGroupsState.readAll()[
        buildSessionListCollapseKey(CONTEXT, 'section:launch')
      ],
    ).toBe(false);
  });
});
