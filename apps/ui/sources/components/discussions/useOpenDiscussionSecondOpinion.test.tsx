import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const viewport = vi.hoisted(() => ({
  width: 1440,
  height: 1000,
  scale: 1,
  fontScale: 1,
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
    Dimensions: {
      get: () => viewport,
      addEventListener: () => ({ remove: () => {} }),
    },
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const modal = vi.hoisted(() => ({
  show: null as null | ((config: unknown) => string),
}));
vi.mock('@/modal', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/modal')
  ).createModalModuleMock();
  modal.show = mock.module.Modal.show as (config: unknown) => string;
  return mock.module;
});

const runtime = installSessionPaneRuntimeTestHarness({
  scopeId: ({ sessionId, serverId }) =>
    createSessionPaneScopeId(sessionId, serverId),
});
const {
  useOpenDiscussionSecondOpinion,
  readDiscussionSecondOpinionPaneRequest,
} = await import('./useOpenDiscussionSecondOpinion');
const { DiscussionSecondOpinionPaneTab } =
  await import('./DiscussionSecondOpinionPaneTab');
const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');

function DetailsRenderer() {
  const register = useAppPaneContext(value => value.registerDriver);
  const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
  React.useEffect(() => register({ scopeId, detailsPaneBuiltinAdapter: {
    destinationIds: ['details'], render: () => <>{'Session Details'}</>,
  } }), [register, scopeId]);
  return null;
}

function MountedPaneWrapper({ children }: React.PropsWithChildren) {
  return <runtime.Wrapper><DetailsRenderer />{children}</runtime.Wrapper>;
}

function request() {
  return {
    source: {
      kind: 'session' as const,
      message: {
        kind: 'session' as const,
        session: { serverId: runtime.serverId, sessionId: 's1' },
        messageId: 'answer-1',
      },
    },
    intent: 'second_opinion' as const,
    sourceText: 'Use exponential backoff from 400 ms.',
    onNavigate: () => {},
  };
}

const renders = { count: 0 };
/** One transcript row's share of the entry: the opener and nothing else. */
function Row(props: Readonly<{ scopeId: string }>) {
  useOpenDiscussionSecondOpinion(props.scopeId);
  renders.count += 1;
  return null;
}

describe('Second opinion entry', () => {
  beforeEach(() => {
    viewport.width = 1440;
    renders.count = 0;
    vi.mocked(modal.show!).mockClear();
  });
  afterEach(standardCleanup);

  it('opens beside the transcript as a Details pane on a wide screen, not a dialog', async () => {
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const hook = await renderHook(
      () => useOpenDiscussionSecondOpinion(scopeId),
      { wrapper: MountedPaneWrapper },
    );
    await act(async () => hook.getCurrent()(request()));
    expect(modal.show).not.toHaveBeenCalled();
    const tab = runtime.pane.scopeState?.details.tabs.at(-1);
    expect(tab).toMatchObject({
      kind: 'secondOpinion',
      isPinned: true,
      resource: {
        kind: 'secondOpinion',
        address: { serverId: runtime.serverId, sessionId: 's1' },
      },
    });
    // The answer text stays in memory with the open pane; persisted pane state carries only its id.
    expect(JSON.stringify(tab)).not.toContain('exponential');
    const requestId = (tab!.resource as { requestId: string }).requestId;
    expect(readDiscussionSecondOpinionPaneRequest(requestId)?.sourceText).toBe(
      'Use exponential backoff from 400 ms.',
    );
  });

  it('opens the same scoped Details destination in the phone Start sheet', async () => {
    viewport.width = 390;
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const hook = await renderHook(
      () => useOpenDiscussionSecondOpinion(scopeId),
      { wrapper: runtime.Wrapper },
    );
    await act(async () => hook.getCurrent()(request()));
    expect(modal.show).toHaveBeenCalledWith(
      expect.objectContaining({
        chrome: expect.objectContaining({ phonePresentation: 'sheet' }),
      }),
    );
    expect(runtime.pane.scopeState?.details.tabs.at(-1)).toMatchObject({
      kind: 'secondOpinion',
      resource: { address: { serverId: runtime.serverId, sessionId: 's1' } },
    });
  });

  it.each([390, 1440])('uses the shared pane authority inside a no-column host at width %s', async width => {
    viewport.width = width;
    const hook = await renderHook(() => useOpenDiscussionSecondOpinion(createSessionPaneScopeId('s1', runtime.serverId)),
      { wrapper: runtime.Wrapper });
    await act(async () => hook.getCurrent()(request()));
    const { PhoneDetailsStartSheet } = await import('@/components/appShell/panes/details/PhoneDetailsStartSheet');
    expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
      component: PhoneDetailsStartSheet,
      chrome: expect.objectContaining({ phonePresentation: 'sheet', dimensions: { size: 'lg' } }),
    }));
  });

  it('releases a request when its Details workspace closes and keeps other-tab drafts until then', async () => {
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const host: { open?: ReturnType<typeof useOpenDiscussionSecondOpinion> } = {};
    function Host(props: Readonly<{ requestId?: string; tabKey?: string }>) {
      host.open = useOpenDiscussionSecondOpinion(scopeId);
      return props.requestId && props.tabKey ? <DiscussionSecondOpinionPaneTab requestId={props.requestId}
        paneScopeId={scopeId} tabKey={props.tabKey} onCloseTab={() => {}} onOpenDiscussion={() => {}} /> : null;
    }
    const screen = await renderScreen(<Host />, { wrapper: runtime.Wrapper });
    await act(async () => host.open!(request()));
    const tab = runtime.pane.scopeState!.details.tabs.at(-1)!;
    const requestId = (tab.resource as { requestId: string }).requestId;
    await screen.update(<Host requestId={requestId} tabKey={tab.key} />);
    await act(async () => runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
    expect(readDiscussionSecondOpinionPaneRequest(requestId)).not.toBeNull();
    await act(async () => runtime.pane.closeDetails());
    expect(readDiscussionSecondOpinionPaneRequest(requestId)).toBeNull();
  });

  it('uses the shared Start sheet when an AppPane provider exists but this wide host has no Details renderer', async () => {
    const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
    const wrapper = ({ children }: { children?: React.ReactNode }) => <runtime.Wrapper>
      <PanePresentationProvider value={() => 'startSheet'}>{children}</PanePresentationProvider>
    </runtime.Wrapper>;
    const hook = await renderHook(() => useOpenDiscussionSecondOpinion(createSessionPaneScopeId('s1', runtime.serverId)), { wrapper });
    await act(async () => hook.getCurrent()(request()));
    const { PhoneDetailsStartSheet } = await import('@/components/appShell/panes/details/PhoneDetailsStartSheet');
    expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({ component: PhoneDetailsStartSheet }));
  });

  it('keeps the request while another tab is in front and releases it when its tab closes from the strip', async () => {
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const host: { open?: ReturnType<typeof useOpenDiscussionSecondOpinion>; show?: (shown: boolean) => void } = {};
    function Host(props: Readonly<{ requestId: string | null; tabKey: string | null }>) {
      host.open = useOpenDiscussionSecondOpinion(scopeId);
      const [shown, setShown] = React.useState(true);
      host.show = setShown;
      return shown && props.requestId && props.tabKey ? <DiscussionSecondOpinionPaneTab requestId={props.requestId}
        paneScopeId={scopeId} tabKey={props.tabKey} onCloseTab={() => {}} onOpenDiscussion={() => {}} /> : null;
    }
    const screen = await renderScreen(<Host requestId={null} tabKey={null} />, { wrapper: runtime.Wrapper });
    await act(async () => host.open!(request()));
    const tab = runtime.pane.scopeState!.details.tabs.at(-1)!;
    const requestId = (tab.resource as { requestId: string }).requestId;
    await screen.update(<Host requestId={requestId} tabKey={tab.key} />);
    // Another tab comes to the front and the form unmounts: the request stays.
    await act(async () => runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }));
    await act(async () => host.show!(false));
    expect(readDiscussionSecondOpinionPaneRequest(requestId)).not.toBeNull();
    await act(async () => host.show!(true));
    await act(async () => runtime.pane.closeDetailsTab(tab.key));
    expect(readDiscussionSecondOpinionPaneRequest(requestId)).toBeNull();
  });

  it('costs a transcript row no render when pane state changes (300 rows)', async () => {
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    await renderScreen(
      <>
        {Array.from({ length: 300 }, (_, index) => (
          <Row key={index} scopeId={scopeId} />
        ))}
      </>,
      { wrapper: runtime.Wrapper },
    );
    const mounted = renders.count;
    expect(mounted).toBeGreaterThanOrEqual(300);
    await act(async () =>
      runtime.pane.openDetailsTab(createSessionBoardDetailsTab(), {
        intent: 'pinned',
      }),
    );
    await act(async () =>
      runtime.pane.closeDetailsTab(createSessionBoardDetailsTab().key),
    );
    expect(renders.count).toBe(mounted);
  });
});
