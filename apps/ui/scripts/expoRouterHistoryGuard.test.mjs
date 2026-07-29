import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const React = require('react');
const TestRenderer = require('react-test-renderer');

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const expoRouterRoot = process.env.HAPPIER_EXPO_ROUTER_ROOT
  ?? join(packageRoot, 'node_modules', 'expo-router');
const useLinkingPath = join(
  expoRouterRoot,
  'build',
  'fork',
  'useLinking.js',
);

async function loadNavigationCore() {
  const coreEntry = require.resolve('@react-navigation/core', { paths: [packageRoot] });
  return import(pathToFileURL(coreEntry).href);
}

async function loadExpoRouterUseLinking(core) {
  const source = await readFile(useLinkingPath, 'utf8');
  const localRequire = createRequire(useLinkingPath);
  const module = { exports: {} };
  const requireFromFork = (specifier) => {
    if (specifier === '@react-navigation/native') return core;
    if (specifier === './getPathFromState') {
      return { appendBaseUrl: (path) => path };
    }
    if (specifier === '../global-state/utils') {
      return { getRootStackRouteNames: () => ['List', 'Dirty'] };
    }
    return localRequire(specifier);
  };

  const evaluate = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    source,
  );
  evaluate(module.exports, requireFromFork, module, useLinkingPath, dirname(useLinkingPath));
  return module.exports.useLinking;
}

function createBrowserHarness(initialPath) {
  const listeners = new Map();
  const timers = new Set();
  const location = {
    hash: '',
    pathname: '/',
    search: '',
  };
  const entries = [{ state: null, path: initialPath }];
  const queuedPopStateDelays = [];
  const goCalls = [];
  let index = 0;

  const updateLocation = (path) => {
    const parsed = new URL(path, 'http://happier.test');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const emit = (type) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener({ type });
    }
  };
  const schedulePopState = () => {
    const delay = queuedPopStateDelays.length > 0 ? queuedPopStateDelays.shift() : 0;
    if (delay === null) return;
    if (delay === 0) {
      queueMicrotask(() => emit('popstate'));
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      emit('popstate');
    }, delay);
    timers.add(timer);
  };
  const go = (delta) => {
    goCalls.push(delta);
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= entries.length || nextIndex === index) return;
    index = nextIndex;
    updateLocation(entries[index].path);
    schedulePopState();
  };

  updateLocation(initialPath);
  const window = {
    document: { title: 'Happier test' },
    history: {
      get length() {
        return entries.length;
      },
      get state() {
        return entries[index].state;
      },
      go,
      pushState(state, _title, path) {
        entries.splice(index + 1);
        entries.push({ state, path });
        index = entries.length - 1;
        updateLocation(path);
      },
      replaceState(state, _title, path) {
        entries[index] = { state, path };
        updateLocation(path);
      },
    },
    location,
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    cleanup() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    get currentIndex() {
      return index;
    },
    get entries() {
      return entries;
    },
    go,
    goCalls,
    location,
    pushHash(hash) {
      entries.splice(index + 1);
      entries.push({
        state: entries[index].state,
        path: `${location.pathname}${location.search}${hash}`,
      });
      index = entries.length - 1;
      updateLocation(entries[index].path);
      schedulePopState();
    },
    queuePopStateDelays(...delays) {
      queuedPopStateDelays.push(...delays);
    },
    window,
  };
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function renderLinkingHarness(t, {
  navigateViaOther = false,
  transformStoreState = (state) => state,
  wrapRootState = false,
} = {}) {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const browser = createBrowserHarness('/settings/providers');
  globalThis.window = browser.window;
  globalThis.location = browser.location;
  globalThis.document = browser.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const core = await loadNavigationCore();
  const useLinking = await loadExpoRouterUseLinking(core);
  const storeContextPath = join(
    expoRouterRoot,
    'build',
    'global-state',
    'storeContext.js',
  );
  const { StoreContext } = require(storeContextPath);
  const store = { state: undefined };
  const navigationRef = React.createRef();
  let shouldWrapRootState = wrapRootState;
  let wrappedUnderlyingRootState;
  let wrappedRootState;
  let navigationProxy;
  let navigationProxyTarget;
  const linkingNavigationRef = {
    get current() {
      const navigation = navigationRef.current;
      if (!navigation || !shouldWrapRootState) return navigation;
      if (navigationProxyTarget !== navigation) {
        navigationProxyTarget = navigation;
        navigationProxy = new Proxy(navigation, {
          get(target, property) {
            if (property === 'getRootState' && shouldWrapRootState) {
              return () => {
                const underlyingRootState = target.getRootState();
                if (wrappedUnderlyingRootState !== underlyingRootState) {
                  wrappedUnderlyingRootState = underlyingRootState;
                  wrappedRootState = {
                    index: 0,
                    key: 'expo-internal-root',
                    routeNames: ['__root'],
                    routes: [{
                      key: 'expo-internal-slot',
                      name: '__root',
                      state: underlyingRootState,
                    }],
                    stale: false,
                    type: 'stack',
                  };
                }
                return wrappedRootState;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return navigationProxy;
    },
  };
  const guard = {
    mode: 'prevent',
    removalAttempts: 0,
  };

  function SimpleTestNavigator({ children, initialRouteName }) {
    const { state, descriptors, NavigationContent } = core.useNavigationBuilder(
      core.StackRouter,
      { children, initialRouteName },
    );
    store.state = transformStoreState(state);
    return React.createElement(
      NavigationContent,
      null,
      descriptors[state.routes[state.index].key].render(),
    );
  }
  const Stack = core.createNavigatorFactory(SimpleTestNavigator)();

  function ListScreen() {
    return null;
  }

  function OtherScreen() {
    return null;
  }

  function DirtyScreen() {
    const navigation = core.useNavigation();
    core.usePreventRemove(true, ({ data }) => {
      guard.removalAttempts += 1;
      if (guard.mode === 'continue') {
        navigation.dispatch(data.action);
      }
    });
    return null;
  }

  function LinkingHarness() {
    useLinking(linkingNavigationRef, {
      enabled: true,
      getActionFromState: () => core.CommonActions.navigate('Dirty'),
      getPathFromState: (state) => {
        const route = core.findFocusedRoute(state);
        if (route?.name === 'Dirty') return '/settings/providers/new';
        if (route?.name === 'Other') return '/settings/providers/other';
        return '/settings/providers';
      },
      getStateFromPath: (path) => path.includes('#')
        ? navigationRef.current?.getRootState()
        : undefined,
    }, () => {});

    const navigator = React.createElement(
      Stack.Navigator,
      { initialRouteName: 'List' },
      React.createElement(Stack.Screen, { component: ListScreen, name: 'List' }),
      React.createElement(Stack.Screen, { component: DirtyScreen, name: 'Dirty' }),
      React.createElement(Stack.Screen, { component: OtherScreen, name: 'Other' }),
    );

    return React.createElement(
      core.BaseNavigationContainer,
      {
        ref: navigationRef,
      },
      navigator,
    );
  }

  let renderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        StoreContext.Provider,
        { value: store },
        React.createElement(LinkingHarness),
      ),
    );
    await flushEffects();
  });

  if (navigateViaOther) {
    await TestRenderer.act(async () => {
      navigationRef.current.navigate('Other');
      await flushEffects();
    });
  }

  await TestRenderer.act(async () => {
    navigationRef.current.navigate('Dirty');
    await flushEffects();
  });
  assert.equal(browser.location.pathname, '/settings/providers/new');

  t.after(async () => {
    await TestRenderer.act(async () => {
      renderer.unmount();
      await flushEffects();
    });
    browser.cleanup();
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  return {
    browser,
    guard,
    getLinkingRootState() {
      return linkingNavigationRef.current.getRootState();
    },
    navigationRef,
    setRootStateWrapped(value) {
      shouldWrapRootState = value;
    },
  };
}

test('Expo Router browser history returns to a dirty route when actual core prevents removal', async (t) => {
  const { browser, guard } = await renderLinkingHarness(t);

  await TestRenderer.act(async () => {
    browser.go(-1);
    await flushEffects();
  });

  assert.equal(
    guard.removalAttempts,
    1,
    JSON.stringify({ path: browser.location.pathname, goCalls: browser.goCalls }),
  );
  assert.equal(browser.location.pathname, '/settings/providers/new');
});

test('Expo Router compares fork history records with the focused store state', async (t) => {
  const { browser, guard, setRootStateWrapped } = await renderLinkingHarness(t);
  setRootStateWrapped(true);

  await TestRenderer.act(async () => {
    browser.go(-1);
    await flushEffects();
  });

  assert.equal(guard.removalAttempts, 1);
  assert.equal(browser.location.pathname, '/settings/providers/new');
});

test('Expo Router internal-slot navigation does not traverse browser history for a focused-state collapse', async (t) => {
  const transformStoreState = (state) => {
    const focusedRoute = state.routes[state.index];
    if (focusedRoute?.name !== 'Dirty') return state;
    return {
      ...state,
      index: 0,
      routes: [focusedRoute],
    };
  };
  const { browser } = await renderLinkingHarness(t, {
    navigateViaOther: true,
    transformStoreState,
  });

  assert.equal(browser.location.pathname, '/settings/providers/new');
  assert.equal(browser.currentIndex, 2);
  assert.deepEqual(browser.goCalls, []);
});

test('Expo Router accounts for the browser pop delta when actual core continues removal', async (t) => {
  const { browser, guard } = await renderLinkingHarness(t);
  guard.mode = 'continue';

  await TestRenderer.act(async () => {
    browser.go(-1);
    await flushEffects();
  });

  assert.equal(guard.removalAttempts, 1);
  assert.equal(browser.location.pathname, '/settings/providers');
});

test('Expo Router rollback settles without popstate after the 100ms history fallback', async (t) => {
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));
  const { browser } = await renderLinkingHarness(t);
  browser.queuePopStateDelays(0, null);

  await TestRenderer.act(async () => {
    browser.go(-1);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await flushEffects();
  });

  assert.equal(browser.location.pathname, '/settings/providers/new');
  assert.deepEqual(unhandledRejections, []);
});

test('Expo Router preserves hash-only traversal without invoking the removal guard', async (t) => {
  const { browser, guard } = await renderLinkingHarness(t);

  await TestRenderer.act(async () => {
    browser.pushHash('#credentials');
    await flushEffects();
  });

  assert.equal(browser.location.pathname, '/settings/providers/new');
  assert.equal(browser.location.hash, '#credentials');
  assert.equal(guard.removalAttempts, 0);
});

test('Expo Router repeatedly rolls browser Back to the dirty route', async (t) => {
  const { browser, guard } = await renderLinkingHarness(t);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await TestRenderer.act(async () => {
      browser.go(-1);
      await flushEffects();
    });
    assert.equal(browser.location.pathname, '/settings/providers/new');
  }

  assert.equal(guard.removalAttempts, 2);
  assert.deepEqual(browser.goCalls, [-1, 1, -1, 1]);
});
