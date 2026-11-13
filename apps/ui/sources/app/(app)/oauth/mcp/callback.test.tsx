import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_OAUTH_CALLBACK_URL_V1,
  MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { act } from 'react-test-renderer';
import { StackActions, StackRouter } from '@react-navigation/routers';
import { BaseNavigationContainer, createNavigationContainerRef, createNavigatorFactory,
  getPathFromState, getStateFromPath, useNavigationBuilder, useNavigation, useRoute } from '@react-navigation/core';
import { createMemoryHistory } from 'expo-router/build/fork/createMemoryHistory';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readMcpOAuthOpenerMessage } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { captureConnectedAccountOAuthCallbackUrl, readCapturedConnectedAccountOAuthCallbackUrl } from '@/sync/ops/connectedAccounts/connectedAccountOAuthCallbackUrl';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
  signedIn: false,
  ready: true,
  current: true,
  bindingStarted: vi.fn(),
  execute: vi.fn(),
  replace: vi.fn(),
  realNavigation: false,
  globalSetParams: undefined as undefined | ((params: Record<string, unknown>) => void),
  mountedActionExecution: undefined as undefined | typeof import('@/components/approvals/useMountedActionExecution').useMountedActionExecution,
  params: {} as Record<string, string | string[] | undefined>,
  clipboard: vi.fn(async (_value: string) => true),
  signal: new AbortController().signal,
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
// Expo's CJS entry bypasses Vitest's native aliases; preserve its installed
// serializer while adapting only the native module loader boundary.
vi.mock('expo-router/build/fork/getPathFromState', async () =>
  (await import('@/dev/testkit/runtime/installedExpoPathSerializer')).loadInstalledExpoPathSerializer(),
);
vi.mock('expo-router', async () => {
  const router = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock({
    params: () => boundary.params,
  });
  const { createNavigatorFactory } = await import('@react-navigation/core');
  const nativeStack = createNavigatorFactory(Navigator)();
  const StackRoot = (props: React.ComponentProps<typeof nativeStack.Navigator>) => <nativeStack.Navigator {...props} />;
  return {
    ...router.module,
    Stack: Object.assign(StackRoot, { Screen: nativeStack.Screen }),
    useNavigation: () => boundary.realNavigation ? useNavigation() : router.module.useNavigation(),
    // Expo exposes these native objects; the hydration regression keeps their lifecycle real.
    useLocalSearchParams: () => boundary.realNavigation ? useRoute().params ?? {} : router.module.useLocalSearchParams(),
    useRouter: () => {
      const navigation = boundary.realNavigation ? useNavigation() : null;
      return { ...router.module.useRouter(), replace: boundary.replace,
        ...(boundary.globalSetParams ? { setParams: boundary.globalSetParams } : navigation ? { setParams: navigation.setParams } : {}) };
    },
  };
});
// Credentials and the mounted Action front door are the boundaries; the callback controller runs for real.
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: boundary.signedIn }),
}));
vi.mock('@/components/approvals/useMountedActionExecution', async () => {
  const React = await import('react');
  return { useMountedActionExecution: (scope: Parameters<NonNullable<typeof boundary.mountedActionExecution>>[0]) => {
    if (boundary.mountedActionExecution) return boundary.mountedActionExecution(scope);
    React.useEffect(() => { boundary.bindingStarted(); }, []);
    return {
    execute: boundary.execute,
    ready: Boolean(scope) && boundary.ready,
    isCurrent: () => boundary.current,
    getSignal: () => boundary.signal,
    resolution: boundary.signedIn ? { kind: 'bound', scope } : { kind: 'signed_out' },
    approval: {},
    };
  } };
});
vi.mock('expo-clipboard', () => ({
  setStringAsync: boundary.clipboard,
  getStringAsync: async () => '',
}));

const { default: McpOAuthCallbackRoute } = await import('./callback');
const { default: ConnectedAccountOAuthCallbackRoute } = await import('../connected-account/callback');
const genericCallbackUrl = 'https://app.happier.dev/oauth/connected-account/callback';

const query =
  '?code=code-1&state=attempt-1.nonce&iss=https%3A%2F%2Fissuer.example';
const browser = globalThis as unknown as Record<string, unknown>;
let replaced: string[];
let posted: Array<{ message: unknown; origin: string }>;

function install(openerOrigin?: string) {
  replaced = [];
  posted = [];
  browser.location = { search: query };
  browser.history = {
    replaceState: (_d: unknown, _u: string, url: string) => replaced.push(url),
  };
  browser.close = vi.fn();
  browser.opener = openerOrigin
    ? {
        get location() {
          if (openerOrigin === 'inaccessible') throw new DOMException('Cross-origin access denied', 'SecurityError');
          return { origin: openerOrigin };
        },
        postMessage: (message: unknown, origin: string) =>
          posted.push({ message, origin }),
      }
    : null;
}

beforeEach(() => {
  vi.stubGlobal('navigator', { clipboard: { writeText: boundary.clipboard } });
  // HTTP is a genuine boundary: callback code may invoke Actions, never a vendor or server exchange.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Callback must not send HTTP'));
  boundary.signedIn = false;
  boundary.ready = true;
  boundary.current = true;
  boundary.bindingStarted.mockReset();
  boundary.execute.mockReset();
  boundary.replace.mockReset();
  boundary.realNavigation = false;
  boundary.globalSetParams = undefined;
  boundary.mountedActionExecution = undefined;
  boundary.params = {};
  boundary.clipboard.mockClear();
  getStorage().setState({ settingsScope: null });
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await standardCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['location', 'history', 'close', 'opener'])
    delete browser[key];
});

async function settle(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    for (let i = 0; i < 40; i += 1) {
        if (screen.findAllByTestId(testID).length > 0) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    throw new Error(`never showed ${testID}: ${screen.getTextContent()}`);
}

function Navigator({ children }: React.PropsWithChildren) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children });
  return <NavigationContent>{descriptors[state.routes[state.index]!.key]!.render()}</NavigationContent>;
}
const Stack = createNavigatorFactory(Navigator)();

// Keep Expo's installed readiness assertion and parameter operation intact. Only
// bind its global store to this real root ref; DOM forwarding is the real SDK too.
async function installedGlobalSetParams(navigationRef: ReturnType<typeof createNavigationContainerRef>) {
  const require = createRequire(import.meta.url);
  const source = await readFile(require.resolve('expo-router/build/global-state/routing'), 'utf8');
  const readinessStart = source.indexOf('function assertIsReady()');
  const readiness = source.slice(readinessStart, source.indexOf('exports.routingQueue =', readinessStart));
  const setter = source.slice(source.indexOf('function setParams('), source.indexOf('function linkTo('));
  if (!readiness || !setter) throw new Error('Installed Expo parameter operation unavailable');
  // Published CJS has no types; keep the boundary local to its actual API shape.
  return new Function('router_store_1', 'emitDomEvent_1', `${readiness}\n${setter}\nreturn setParams;`)(
    { store: { navigationRef } }, require('expo-router/build/domComponents/emitDomEvent'),
  ) as (params: Record<string, unknown>) => void;
}

class CallbackErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? React.createElement('View', { testID: 'callback-root-error' }, this.state.error.message) : this.props.children; }
}

describe('callback root navigation readiness', () => {
  it.each([
    { path: '/oauth/connected-account/callback', Route: ConnectedAccountOAuthCallbackRoute, prefix: 'connected-account-oauth-callback' },
    { path: '/oauth/mcp/callback', Route: McpOAuthCallbackRoute, prefix: 'mcp-oauth-callback' },
  ])('clears $path through its mounted route while the root navigator registers', async ({ path, Route, prefix }) => {
    install();
    browser.location = new URL('https://app.happier.dev/settings/connected-services');
    boundary.realNavigation = true;
    const root = createNavigationContainerRef();
    boundary.globalSetParams = await installedGlobalSetParams(root);
    boundary.mountedActionExecution = (await vi.importActual<typeof import('@/components/approvals/useMountedActionExecution')>(
      '@/components/approvals/useMountedActionExecution',
    )).useMountedActionExecution;
    const { WorkspaceRootStack } = await import('@/components/appShell/workspace/WorkspaceRootStack');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { resolveHref } = await import('expo-router/build/link/href');
    const config = { screens: { callback: path.slice(1) } };
    let arrive: (href: string) => void = () => { throw new Error('app not mounted'); };
    const readiness: boolean[] = [];
    function Callback() {
      React.useLayoutEffect(() => { readiness.push(root.isReady()); }, []);
      return <Route />;
    }
    function App() {
      const [href, setHref] = React.useState<string | null>(null);
      const url = href ? new URL(href, 'https://app.happier.dev') : null;
      const navigation = { push: (next: Parameters<typeof resolveHref>[0]) => setHref(resolveHref(next)), replace: vi.fn(), back: vi.fn() };
      // A string Href resolves to itself, so arrival publishes the pushed path directly.
      arrive = setHref;
      // The app/retained Credentials surface is already mounted. A public callback
      // mounts its real root navigator; the child layout effect runs before onReady.
      return <CallbackErrorBoundary>{url ? <BaseNavigationContainer ref={root}
        initialState={getStateFromPath(`${url.pathname}${url.search}`, config)!}>
        <WorkspaceRootStack><WorkspaceRootStack.Screen name="callback" component={Callback} /></WorkspaceRootStack>
      </BaseNavigationContainer> : <DestinationInstanceHost tabId="credentials" ref={{ kind: 'settings', params: { pageId: 'connected-services' } }}
        pathname="/settings/connected-services" focused visible navigation={navigation}>{null}</DestinationInstanceHost>}</CallbackErrorBoundary>;
    }
    const screen = await renderScreen(<App />);
    await act(async () => { arrive(`${path}${query}`); });
    await settle(screen, `${prefix}:paste`);
    expect(readiness).toContain(false);
    expect(screen.findAllByTestId('callback-root-error')).toHaveLength(0);
    expect(root.isReady()).toBe(true);
    expect(getPathFromState(root.getRootState(), config)).toBe(path);
    await screen.pressByTestIdAsync(`${prefix}:copy`);
    expect(boundary.clipboard).toHaveBeenCalledWith(`https://app.happier.dev${path}${query}`);
  });
});

describe('/oauth/mcp/callback', () => {
  it.each([
    { path: '/oauth/connected-account/callback', Route: ConnectedAccountOAuthCallbackRoute, prefix: 'connected-account-oauth-callback' },
    { path: '/oauth/mcp/callback', Route: McpOAuthCallbackRoute, prefix: 'mcp-oauth-callback' },
  ])('keeps $path query-free when its lazy navigator hydrates and after paste recovery', async ({ path, Route, prefix }) => {
    install();
    boundary.realNavigation = true;
    const original = `https://app.happier.dev${path}${query}&provider_extra=private`;
    browser.location = new URL(original);
    vi.stubGlobal('window', globalThis);
    const history = {
      state: null as unknown,
      writes: [] as string[],
      replaceState(data: unknown, _unused: string, href: string) {
        history.state = data;
        history.writes.push(href);
        browser.location = new URL(href, original);
      },
    };
    browser.history = history;
    // The real app entry runs this before Expo's initial-URL parser. Keep the
    // original answer in memory while every router state sees only the path.
    captureConnectedAccountOAuthCallbackUrl({ location: browser.location as URL, history });
    const config = { screens: { app: { path: '', screens: { callback: path.slice(1) } } } };
    const initialLocation = browser.location as URL;
    const initialState = getStateFromPath(`${initialLocation.pathname}${initialLocation.search}`, config)!;
    const navigation = createNavigationContainerRef();
    let admit: () => void = () => { throw new Error('not mounted'); };
    let callbackKey: string | undefined;
    function Callback() {
      callbackKey = useRoute().key;
      return <Route />;
    }
    function App() {
      const [ready, setReady] = React.useState(false);
      admit = () => setReady(true);
      return ready ? <Stack.Navigator><Stack.Screen name="callback" component={Callback} /></Stack.Navigator> : null;
    }
    const mirror = createMemoryHistory();
    const projectNavigation = () => {
      const state = navigation.getRootState();
      mirror.replace({ path: getPathFromState(state, config), state });
    };
    const screen = await renderScreen(<BaseNavigationContainer ref={navigation} initialState={initialState} onStateChange={projectNavigation}>
      <Stack.Navigator><Stack.Screen name="app" component={App} /></Stack.Navigator>
    </BaseNavigationContainer>, { wrapper: path.includes('connected-account') ? React.StrictMode : undefined });
    await act(async () => { admit(); });
    const routeKey = callbackKey;
    await settle(screen, `${prefix}:paste`);
    // Expo's history writer serializes this same committed native navigation state.
    await act(async () => { projectNavigation(); });
    expect((browser.location as URL).search).toBe('');
    expect(mirror.get(mirror.index).path).toBe(path);
    expect(callbackKey).toBe(routeKey);
    await screen.pressByTestIdAsync(`${prefix}:copy`);
    await act(async () => { projectNavigation(); });
    expect((browser.location as URL).search).toBe('');
    expect(boundary.clipboard).toHaveBeenCalledWith(original);
    expect(navigation.getRootState().routes[0]!.state!.routes[0]!.params).toBeUndefined();
    expect(history.writes.every(href => new URL(href, original).search === '')).toBe(true);
    expect(readCapturedConnectedAccountOAuthCallbackUrl(`https://app.happier.dev${path}`)).toBeUndefined();
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it('uses the generic callback identity for the actual generic route', async () => {
    install('https://app.happier.dev');
    await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    expect(replaced).toEqual(['/oauth/connected-account/callback']);
    expect(posted).toEqual([{ origin: 'https://app.happier.dev', message: {
      type: 'happier.connected-account.oauth', code: 'code-1', state: 'attempt-1.nonce', iss: 'https://issuer.example',
    } }]);
  });

  it('preserves the full generic callback for signed-out paste recovery', async () => {
    install();
    const screen = await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    await settle(screen, 'connected-account-oauth-callback:paste');
    await screen.pressByTestIdAsync('connected-account-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(`${genericCallbackUrl}${query}`);
  });
  it('strips the callback before waiting for the signed-in Action binding', async () => {
    install();
    boundary.signedIn = true;
    boundary.ready = false;
    boundary.bindingStarted.mockImplementation(() => expect(replaced).toEqual(['/oauth/mcp/callback']));
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'account' } });
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(screen.findAllByTestId('mcp-oauth-callback:working').length).toBeGreaterThan(0);
    expect(boundary.execute).not.toHaveBeenCalled();
  });
  it('hands the answer to an opener on app.happier.dev only, strips the address and calls no Action', async () => {
    install('https://app.happier.dev');
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:opener');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(posted).toEqual([
      {
        origin: 'https://app.happier.dev',
        message: {
          type: 'happier.mcp.oauth',
          code: 'code-1',
          state: 'attempt-1.nonce',
          iss: 'https://issuer.example',
        },
      },
    ]);
    expect(browser.close).toHaveBeenCalled();
    expect(posted.map(({ message, origin }) => readMcpOAuthOpenerMessage({ origin, data: message }))).toEqual([
      { type: 'happier.mcp.oauth', code: 'code-1', state: 'attempt-1.nonce', iss: 'https://issuer.example' },
    ]);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it.each(['https://self-hosted.example', 'inaccessible', 'https://app.happier.dev.evil.example'])('retains the callback for Copy code without closing an untrusted opener: %s', async (origin) => {
    install(origin);
    boundary.signedIn = true;
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'account' } });
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:paste');
    expect(screen.findAllByTestId('mcp-oauth-callback:copy').length).toBeGreaterThan(0);
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(posted).toEqual([]);
    expect(browser.close).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('mcp-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(`${MCP_OAUTH_CALLBACK_URL_V1}${query}`);
  });

  it('signed out, strips the address and offers the full callback to copy', async () => {
    install();
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:paste');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('mcp-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(
      `${MCP_OAUTH_CALLBACK_URL_V1}${query}`,
    );
  });

  it.each([false, true])('signed in, completes with the issuer and retains an editable app refusal (invalidClient=%s)', async invalidClient => {
    install();
    boundary.signedIn = true;
    getStorage().setState({
      settingsScope: { serverId: 'home', accountId: 'account' },
      machines: {},
    });
    const account = {
      service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
      accountId: 'server-1',
    };
    boundary.execute.mockImplementation(
      async (actionId: string, input: Record<string, unknown>) => {
        if (actionId === 'connectedServices.authentication.read')
          return {
            ok: true,
            result: {
              status: 'awaitingOAuth',
              attemptId: 'attempt-1',
              authorizationUrl: 'https://issuer.example/authorize',
              callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
              expiresAtMs: Date.now() + 60_000,
            },
          };
        if (actionId === 'connectedServices.authentication.completeOAuth') {
          expect(input).toEqual({
            attemptId: 'attempt-1',
            completion: {
              code: 'code-1',
              state: 'attempt-1.nonce',
              iss: 'https://issuer.example',
              callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
            },
          });
          return {
            ok: true,
            result: invalidClient ? { status: 'rejected', attemptId: 'attempt-1', code: 'invalid_client',
              diagnostic: { code: 'invalid_client', severity: 'error' } } : { status: 'connected', attemptId: 'attempt-1', account },
          };
        }
        throw new Error(`unexpected ${actionId}`);
      },
    );
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, invalidClient ? 'mcp-oauth-callback:invalid-client' : 'mcp-oauth-callback:connected');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(boundary.execute).toHaveBeenCalledWith(
      'connectedServices.authentication.completeOAuth',
      expect.anything(),
      expect.anything(),
    );
    if (invalidClient) expect(boundary.replace).not.toHaveBeenCalled();
    else expect(boundary.replace).toHaveBeenCalledWith('/settings/mcp/server-1');
  });
});

describe('/oauth/connected-account/callback', () => {
  function signIn() {
    boundary.signedIn = true;
    getStorage().setState({
      settingsScope: { serverId: 'home', accountId: 'account' },
      machines: {},
    });
  }

  it('admits both public callback leaves before sign-in', () => {
    expect(isPublicRouteForUnauthenticated(['(app)', 'oauth', 'connected-account', 'callback'])).toBe(true);
    expect(isPublicRouteForUnauthenticated(['(app)', 'oauth', 'mcp', 'callback'])).toBe(true);
  });

  it('strips the generic query before waiting for an Action binding', async () => {
    install();
    signIn();
    boundary.ready = false;
    await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    expect(replaced).toEqual(['/oauth/connected-account/callback']);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it.each(['https://app.happier.dev.evil.example', 'https://self-hosted.example', 'inaccessible'])('copies the original callback rather than sending it to %s', async origin => {
    install(origin);
    signIn();
    const screen = await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    await settle(screen, 'connected-account-oauth-callback:paste');
    expect(posted).toEqual([]);
    expect(browser.close).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('connected-account-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(`${genericCallbackUrl}${query}`);
  });

  it.each(['connected', 'rejected', 'alreadyConnected'] as const)('reads the exact same-Account attempt through read/complete Action parsing: %s', async status => {
    install();
    signIn();
    const calls: Array<{ actionId: string; input: Record<string, unknown> }> = [];
    boundary.execute.mockImplementation(async (actionId: string, input: Record<string, unknown>) => {
      calls.push({ actionId, input });
      if (actionId === 'connectedServices.authentication.read') {
        if (status === 'alreadyConnected') return { ok: true, result: {
          status: 'connected', attemptId: 'attempt-1',
          account: { service: { pluginId: 'example.accounts', localId: 'api' }, accountId: 'remote' },
        } };
        return { ok: true, result: {
          status: 'awaitingOAuth', attemptId: 'attempt-1', callbackUrl: genericCallbackUrl,
          authorizationUrl: 'https://issuer.example/authorize', expiresAtMs: Date.now() + 60_000,
        } };
      }
      if (actionId === 'connectedServices.authentication.completeOAuth') return { ok: true, result: status === 'connected'
        ? { status, attemptId: 'attempt-1', account: { service: { pluginId: 'example.accounts', localId: 'api' }, accountId: 'remote' } }
        : { status, attemptId: 'attempt-1', code: 'invalid_state' } };
      throw new Error(`unexpected Action ${actionId}`);
    });
    const screen = await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    await settle(screen, `connected-account-oauth-callback:${status === 'rejected' ? 'unfinished' : 'connected'}`);
    expect(calls).toEqual([
      { actionId: 'connectedServices.authentication.read', input: { attemptId: 'attempt-1' } },
      ...(status === 'alreadyConnected' ? [] : [{ actionId: 'connectedServices.authentication.completeOAuth', input: { attemptId: 'attempt-1', completion: {
        code: 'code-1', state: 'attempt-1.nonce', callbackUrl: genericCallbackUrl, iss: 'https://issuer.example',
      } } }]),
    ]);
    if (status !== 'rejected') expect(boundary.replace).toHaveBeenCalledWith('/settings/connected-services');
    else {
      expect(boundary.replace).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('connected-account-oauth-callback:copy');
      expect(boundary.clipboard).toHaveBeenCalledWith(`${genericCallbackUrl}${query}`);
    }
  });

  it.each(['wrongAccount', 'unreachable', 'retired', 'retiredAfterRead', 'wrongCallback'] as const)('keeps the full callback available without exchanging under %s custody', async failure => {
    install();
    signIn();
    if (failure === 'retired') boundary.current = false;
    boundary.execute.mockImplementation(async () => {
      if (failure === 'unreachable') throw new Error('machine_unavailable');
      if (failure === 'retiredAfterRead') boundary.current = false;
      return { ok: true, result: failure === 'wrongCallback' || failure === 'retiredAfterRead'
        ? { status: 'awaitingOAuth', attemptId: 'attempt-1', callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
          authorizationUrl: 'https://issuer.example/authorize', expiresAtMs: Date.now() + 60_000 }
        : { status: 'rejected', attemptId: 'attempt-1', code: 'attempt_not_found' } };
    });
    const screen = await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    await settle(screen, `connected-account-oauth-callback:${failure === 'wrongAccount' || failure === 'wrongCallback' ? 'unfinished' : 'paste'}`);
    expect(boundary.execute.mock.calls.every(([id]) => id === 'connectedServices.authentication.read')).toBe(true);
    if (failure === 'retired') expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('connected-account-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(`${genericCallbackUrl}${query}`);
  });

  it.each([false, true])('relays an explicit denial only to the exact opener, never to a guessed attempt (opener=%s)', async opener => {
    install(opener ? 'https://app.happier.dev' : undefined);
    browser.location = { search: '?error=access_denied&state=attempt-1.nonce&iss=https%3A%2F%2Fissuer.example' };
    signIn();
    const screen = await renderScreen(<ConnectedAccountOAuthCallbackRoute />);
    await settle(screen, `connected-account-oauth-callback:${opener ? 'opener' : 'paste'}`);
    expect(boundary.execute).not.toHaveBeenCalled();
    if (opener) expect(posted).toEqual([{ origin: 'https://app.happier.dev', message: {
      type: 'happier.connected-account.oauth', state: 'attempt-1.nonce', iss: 'https://issuer.example', error: 'access_denied',
    } }]);
    else {
      await screen.pressByTestIdAsync('connected-account-oauth-callback:copy');
      expect(boundary.clipboard).toHaveBeenCalledWith(`${genericCallbackUrl}?error=access_denied&state=attempt-1.nonce&iss=https%3A%2F%2Fissuer.example`);
    }
  });
});
