import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});

// The navigator under test runs on the real navigation library (router, descriptors, focus).
vi.mock('@react-navigation/native', async () => await vi.importActual('@react-navigation/native'));

// The library's tab view is a native-screens boundary: like the real one, it keeps every visited scene
// mounted and shows only the focused one (react-native-screens draws the others `display: none`).
vi.mock('@react-navigation/bottom-tabs', async () => {
  const { View } = await import('react-native');
  return {
    BottomTabView: (
      props: Readonly<{
        state: Readonly<{
          index: number;
          routes: ReadonlyArray<Readonly<{ key: string }>>;
        }>;
        descriptors: Readonly<
          Record<string, Readonly<{ render: () => React.ReactNode }>>
        >;
      }>,
    ) => {
      const focusedKey = props.state.routes[props.state.index]!.key;
      const [visited, setVisited] = React.useState<readonly string[]>([
        focusedKey,
      ]);
      if (!visited.includes(focusedKey)) setVisited([...visited, focusedKey]);
      return React.createElement(
        React.Fragment,
        null,
        props.state.routes
          .filter(
            (route) => visited.includes(route.key) || route.key === focusedKey,
          )
          .map((route) =>
            React.createElement(
              View,
              {
                key: route.key,
                testID: `tab-view-scene:${route.key.split('-')[0]}`,
                style: { display: route.key === focusedKey ? 'flex' : 'none' },
              },
              props.descriptors[route.key]!.render(),
            ),
          ),
      );
    },
  };
});

const { View } = await import('react-native');
const { BaseNavigationContainer, createNavigationContainerRef } =
  await import('@react-navigation/native');
const { createSessionCockpitTabNavigator } =
  await import('./sessionCockpitTabs');

const Tabs = createSessionCockpitTabNavigator();
const composers = new Set<object>();
const drafts: { current: string; set: ((draft: string) => void) | null } = {
  current: '',
  set: null,
};
let fileSceneMounts = 0;

/** The Session screen's one composer: a node identity and its draft. */
function Composer() {
  const identity = React.useRef({}).current;
  const [draft, setDraft] = React.useState('');
  React.useEffect(() => {
    composers.add(identity);
  }, [identity]);
  drafts.current = draft;
  drafts.set = setDraft;
  return <View testID="composer" />;
}

/** The cockpit's frame around the hosted scene: one stable type whose presentation follows `raised`. */
function RaisedFrame(props: React.PropsWithChildren<Readonly<{ raised: boolean }>>) {
  return (
    <View testID={props.raised ? 'raised-layer' : 'hosted-scene'}>
      {props.children}
    </View>
  );
}

function FileScene() {
  React.useEffect(() => {
    fileSceneMounts += 1;
  }, []);
  return <View testID="file-scene" />;
}

describe('session cockpit tabs', () => {
  it('raises the Chat scene over the File scene without remounting its composer or the File scene', async () => {
    const navigation = createNavigationContainerRef<{
      chat: undefined;
      tabs: undefined;
    }>();
    const app = (raised: boolean) => (
      <BaseNavigationContainer ref={navigation}>
        <Tabs.Navigator
          initialRouteName="chat"
          screenOptions={{ headerShown: false, lazy: true, freezeOnBlur: true }}
          tabBar={() => null}
          raisedScene={{
            routeName: 'chat',
            raised,
            Frame: RaisedFrame,
          }}
        >
          <Tabs.Screen name="chat">{() => <Composer />}</Tabs.Screen>
          <Tabs.Screen name="tabs">{() => <FileScene />}</Tabs.Screen>
        </Tabs.Navigator>
      </BaseNavigationContainer>
    );
    const screen = await renderScreen(app(false));
    await act(async () => {
      drafts.set!('Explain this function');
    });
    await act(async () => {
      navigation.navigate('tabs');
    });
    expect(fileSceneMounts).toBe(1);

    // Ask from the File scene: the Chat scene, with its one composer, rises over it.
    await screen.update(app(true));
    const raised = screen.tree.findAllByProps({ testID: 'raised-layer' });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.findAllByProps({ testID: 'composer' })).toHaveLength(1);
    expect(screen.tree.findAllByProps({ testID: 'composer' })).toHaveLength(1);
    expect(composers.size).toBe(1);
    expect(drafts.current).toBe('Explain this function');
    expect(screen.tree.findAllByProps({ testID: 'file-scene' })).toHaveLength(
      1,
    );
    expect(fileSceneMounts).toBe(1);
    expect(navigation.getCurrentRoute()?.name).toBe('tabs');

    // Closed again, and then Chat itself: still the same composer and draft.
    await screen.update(app(false));
    expect(screen.tree.findAllByProps({ testID: 'raised-layer' })).toHaveLength(
      0,
    );
    await act(async () => {
      navigation.navigate('chat');
    });
    expect(composers.size).toBe(1);
    expect(drafts.current).toBe('Explain this function');
    expect(fileSceneMounts).toBe(1);
    await screen.unmount();
  });

  it('withdraws the Chat scene\'s presentation before freezing it when another scene takes over', async () => {
    // Live READY161 (390): the PR glance sheet opened from Chat's composer stayed over the opened detail, because
    // Chat froze in the same render that blurred it and its withdrawal never committed (TL-C phone glance).
    const { useLayoutPresentationActive } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const presented: boolean[] = [];
    function ChatReader() {
      presented.push(useLayoutPresentationActive());
      return <View testID="chat-reader" />;
    }
    const navigation = createNavigationContainerRef<{ chat: undefined; tabs: undefined }>();
    await renderScreen(
      <BaseNavigationContainer ref={navigation}>
        <Tabs.Navigator
          initialRouteName="chat"
          screenOptions={{ headerShown: false, lazy: true, freezeOnBlur: true }}
          tabBar={() => null}
          raisedScene={{ routeName: 'chat', raised: false, Frame: RaisedFrame }}
        >
          <Tabs.Screen name="chat">{() => <ChatReader />}</Tabs.Screen>
          <Tabs.Screen name="tabs">{() => <FileScene />}</Tabs.Screen>
        </Tabs.Navigator>
      </BaseNavigationContainer>,
    );
    expect(presented.at(-1)).toBe(true);
    await act(async () => {
      navigation.navigate('tabs');
    });
    expect(presented.at(-1)).toBe(false);
  });
});
