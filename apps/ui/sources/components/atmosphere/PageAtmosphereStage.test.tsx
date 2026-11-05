import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import {
  DEFAULT_HOME_ATMOSPHERE,
  ATMOSPHERE_PLACES,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { storage } from '@/sync/domains/state/storageStore';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import {
  PageAtmosphereStage,
  pageAtmosphereContext,
} from './PageAtmosphereStage';
import { atmosphereStageStore } from './atmosphereStage';
import { pictureStore } from './pictureStore';

// Select the genuine browser persistence adapter over the fake IndexedDB system boundary.
vi.mock('./pictureStore', async () => import('./pictureStore.web'));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

describe('which destinations are the "other pages" of plan A3', () => {
  it('leaves Home, a Session and a Project to their own frames and makes every other route a page', () => {
    expect(pageAtmosphereContext('/', {})).toBeNull();
    expect(
      pageAtmosphereContext('/session/s1', { id: 's1', serverId: 'srv' }),
    ).toBeNull();
    expect(
      pageAtmosphereContext('/projects/ref-1/code', {
        workspaceRefId: 'ref-1',
      }),
    ).toBeNull();
    expect(pageAtmosphereContext('/settings/appearance', {})).toEqual({
      place: 'pages',
    });
    expect(pageAtmosphereContext('/projects', {})).toEqual({ place: 'pages' });
    expect(pageAtmosphereContext('/projects/open', {})).toEqual({ place: 'pages' });
    expect(pageAtmosphereContext('/projects/sources', {})).toEqual({ place: 'pages' });
  });

  it("carries the Session into a Session's own pages, so they resolve its Project's background", () => {
    expect(
      pageAtmosphereContext('/session/s1/files', { id: 's1', serverId: 'srv' }),
    ).toEqual({
      place: 'pages',
      session: { serverId: 'srv', sessionId: 's1' },
    });
  });
});

function Page(props: { pathname: string; visible?: boolean; focused?: boolean; children?: React.ReactNode }) {
  const focus = React.useRef(true);
  focus.current = (props.focused ?? props.visible !== false) && props.visible !== false;
  const value = React.useMemo(
    () => ({
      tabId: 'tab',
      ref: { kind: 'x', params: {} },
      pathname: props.pathname,
      focused: props.focused ?? props.visible !== false,
      isFocused: () => focus.current,
      visible: props.visible !== false,
    }),
    [props.pathname, props.visible, props.focused],
  );
  return (
    <DestinationInstanceContext.Provider value={value}>
      <PageAtmosphereStage pathname={props.pathname} params={{}}>
        {props.children ?? <Text>page</Text>}
      </PageAtmosphereStage>
    </DestinationInstanceContext.Provider>
  );
}

describe('a page on the shell stage', () => {
  let previous: ReturnType<typeof storage.getState>;
  const setShowOn = (showOn: string[]) =>
    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        homeAtmosphere: {
          ...DEFAULT_HOME_ATMOSPHERE,
          source: 'picture',
          picture: { ref: { kind: 'user', localId: 'page-picture' }, layout: 'wallpaper' },
          showOn: showOn as typeof DEFAULT_HOME_ATMOSPHERE.showOn,
        },
      },
    }));
  beforeEach(async () => {
    previous = storage.getState();
    await pictureStore.put({ localId: 'page-picture', kind: 'user', data: new Blob(['prepared picture']) });
  });
  afterEach(async () => {
    storage.setState(previous, true);
    await pictureStore.remove('page-picture');
  });
  const carried = () => atmosphereStageStore.get().stage?.surface ?? null;

  it('changes showOn without remounting retained page content or rereading unchanged picture bytes', async () => {
    setShowOn([...ATMOSPHERE_PLACES]);
    const content = createRenderCommitCounter();
    const unrelated = createRenderCommitCounter();
    let mounts = 0;
    let unmounts = 0;
    function Content() {
      useRenderCommitCounter(content);
      React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      return <Text>retained content</Text>;
    }
    function Unrelated() {
      useSetting('analyticsOptOut');
      useRenderCommitCounter(unrelated);
      return null;
    }
    const screen = await renderScreen(<><Unrelated />{Array.from({ length: 13 }, (_, index) =>
      <Page key={index} pathname="/inbox" visible={index === 0}><Content /></Page>)}</>);
    await vi.waitFor(() => expect(carried()).toBe('pages'));
    await act(async () => { await pictureStore.get('page-picture'); });
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const initialMounts = mounts;
    content.reset(); unrelated.reset();
    try {
      await act(async () => {
        const state = storage.getState();
        state.applySettings({ ...state.settings, homeAtmosphere: {
          ...structuredClone(state.settings.homeAtmosphere), showOn: ['home', 'pages'],
        } }, (state.settingsVersion ?? 0) + 1);
      });
      expect(storage.getState().settings.homeAtmosphere.showOn).toEqual(['home', 'pages']);
      expect(content.read()).toMatchObject({ renders: 0, commits: 0 });
      expect(unrelated.read()).toMatchObject({ renders: 0, commits: 0 });
      expect(mounts).toBe(initialMounts);
      expect(unmounts).toBe(0);
      expect(transactions).not.toHaveBeenCalled();
      expect(carried()).toBe('pages');
      await act(async () => {
        const state = storage.getState();
        state.applySettings({ ...state.settings, homeAtmosphere: {
          ...state.settings.homeAtmosphere, showOn: ['home'],
        } }, (state.settingsVersion ?? 0) + 1);
      });
      expect(carried()).toBeNull();
      expect(mounts).toBe(initialMounts);
      expect(unmounts).toBe(0);
      expect(transactions).not.toHaveBeenCalled();
    } finally { transactions.mockRestore(); await screen.unmount(); }
  });

  it('carries the backdrop where the setting includes pages, and withdraws it at once when it no longer does', async () => {
    setShowOn([...ATMOSPHERE_PLACES]);
    const screen = await renderScreen(<Page pathname="/inbox" />);
    await vi.waitFor(() => expect(carried()).toBe('pages'));
    await act(async () => {
      setShowOn(['home']);
    });
    expect(carried()).toBeNull();
    await act(async () => {
      screen.unmount();
    });
  });

  it('registers nothing for Home, which holds its own stage, nor for a hidden page', async () => {
    setShowOn([...ATMOSPHERE_PLACES]);
    const home = await renderScreen(<Page pathname="/" />);
    expect(atmosphereStageStore.get().panes).toHaveLength(0);
    await act(async () => {
      home.unmount();
    });
    const hidden = await renderScreen(
      <Page pathname="/inbox" visible={false} />,
    );
    expect(atmosphereStageStore.get().panes).toHaveLength(0);
    await act(async () => {
      hidden.unmount();
    });
  });
});
