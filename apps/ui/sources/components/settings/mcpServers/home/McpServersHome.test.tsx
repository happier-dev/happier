import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type { McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';

import { buildMcpServerCollection } from '../collection/mcpServerCollectionModel';
import type { McpSignInView } from '../signIn/mcpSignInGrantView';
import { buildMcpHome } from './mcpHomeModel';
import { McpServersHomeView, type McpHomeData } from './McpServersHome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: routerPush, replace: vi.fn(), back: vi.fn() } }).module;
});

afterEach(() => { standardCleanup(); routerPush.mockReset(); });

type Kind = 'oauth' | 'key' | 'local' | 'remote';

function entry(
  id: string,
  kind: Kind,
  tools?: number,
): McpServerCatalogEntryV1 {
  const base = {
    id,
    name: id,
    title: id[0]!.toUpperCase() + id.slice(1),
    env: {},
  };
  const snapshot =
    tools === undefined
      ? {}
      : {
          toolsSnapshot: {
            checkedAt: 1,
            machineId: 'm1',
            tools: Array.from({ length: tools }, (_, i) => ({
              name: `t${i}`,
              tokens: 100,
            })),
          },
        };
  if (kind === 'local')
    return {
      ...base,
      transport: 'stdio',
      stdio: { command: 'npx', args: [] },
      ...snapshot,
    } as unknown as McpServerCatalogEntryV1;
  return {
    ...base,
    transport: 'http',
    remote: {
      url: `https://${id}.example/mcp`,
      headers:
        kind === 'key'
          ? { Authorization: { t: 'savedSecret', secretId: `secret-${id}` } }
          : {},
      ...(kind === 'oauth' ? { auth: { kind: 'oauth' } } : {}),
    },
    ...snapshot,
  } as unknown as McpServerCatalogEntryV1;
}

function settings(
  servers: readonly McpServerCatalogEntryV1[],
  off: readonly string[] = [],
): McpServersSettingsV1 {
  return {
    v: 1,
    servers: [...servers],
    bindings: servers
      .filter((server) => !off.includes(server.id))
      .map((server) => ({
        id: `rule-${server.id}`,
        serverId: server.id,
        enabled: true,
        target: { t: 'allMachines' },
      })),
  } as unknown as McpServersSettingsV1;
}

function home(
  input: Readonly<{
    servers: readonly McpServerCatalogEntryV1[];
    off?: readonly string[];
    secrets?: readonly string[];
    dismissed?: boolean;
    suggestions?: readonly string[];
  }>,
) {
  return buildMcpHome({
    rows: buildMcpServerCollection(settings(input.servers, input.off), ''),
    signInOf: () => null,
    savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null,
      (input.secrets ?? []).map(id => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
    firstVisitDismissed: input.dismissed ?? false,
    suggestions: (input.suggestions ?? []).map((key) => ({
      key,
      iconUrl: null,
      title: key,
    })),
  });
}


function homeData(servers: readonly McpServerCatalogEntryV1[], identity: string | null): McpHomeData {
  const model = buildMcpHome({
    rows: buildMcpServerCollection(settings(servers), ''),
    signInOf: () => ({ state: 'connected', identity, scopes: [], lastUsedAt: null }) as McpSignInView,
    savedSecretCatalog: { resolveReference: (ref) => resolveSavedSecretReference(null,
      ['secret-brave'].map((id) => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
    firstVisitDismissed: true,
  });
  return {
    model,
    suggestions: [],
    shelf: { items: [], loading: false, sourceId: null },
    loading: false,
    unavailable: false,
    reload: async () => undefined,
    dismissFirstVisit: () => undefined,
  } as unknown as McpHomeData;
}

describe('MCP homepage legend (lab hm-A2)', () => {
  it('says how each server reaches you right after its name, with no bare "Remote"', async () => {
    const screen = await renderScreen(
      <McpServersHomeView home={homeData([entry('fetch', 'local', 1), entry('github', 'oauth', 41), entry('brave', 'key'), entry('plain', 'remote')], 'leeroy-brun')} />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('npx · Everywhere');
    expect(text).toContain('as leeroy-brun');
    expect(text).toContain('API key · saved secret');
    expect(text).toContain('1 tool');
    expect(text).not.toMatch(/\b1 tools/);
    expect(text).not.toContain('Remote');
  });
});

describe('MCP homepage Needs you (lab n:home, S30-R05)', () => {
  it('leads with what needs the person: the section stands above the map and its legend', async () => {
    const servers = [entry('github', 'oauth', 41), entry('fetch', 'local', 1)];
    const model = buildMcpHome({
      rows: buildMcpServerCollection(settings(servers), ''),
      signInOf: (id) => (id === 'github' ? { state: 'expired', reason: 'expired' } : null) as McpSignInView | null,
      savedSecretCatalog: { resolveReference: (ref) => resolveSavedSecretReference(null, [], ref) },
      firstVisitDismissed: true,
    });
    const screen = await renderScreen(<McpServersHomeView home={{ ...homeData([], null), model }} />);
    const order = screen.findAll((node) => node.props?.testID === 'mcp.home.needs' || node.props?.testID === 'mcp.home.reach')
      .map((node) => node.props.testID);
    expect([...new Set(order)]).toEqual(['mcp.home.needs', 'mcp.home.reach']);
  });

  it('lists each server that needs the person, most blocking first, and its one fix opens that server', async () => {
    // brave's saved key is held; postgres's is not; github's sign-in expired.
    const servers = [entry('brave', 'key'), entry('postgres', 'key', 3), entry('github', 'oauth', 41), entry('fetch', 'local', 1)];
    const model = buildMcpHome({
      rows: buildMcpServerCollection(settings(servers), ''),
      signInOf: (id) => (id === 'github' ? { state: 'expired', reason: 'expired' } : null) as McpSignInView | null,
      savedSecretCatalog: { resolveReference: (ref) => resolveSavedSecretReference(null,
        ['secret-brave'].map((id) => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
      firstVisitDismissed: true,
    });
    const screen = await renderScreen(<McpServersHomeView home={{ ...homeData([], null), model }} />);

    const section = screen.findByTestId('mcp.home.needs');
    expect(section).not.toBeNull();
    const rows = screen.findAll((node) => typeof node.props?.testID === 'string'
      && /^mcp\.home\.needs\.[a-z]+$/.test(node.props.testID) && node.props.mark !== undefined);
    expect(rows.map((node) => node.props.testID)).toEqual(model.attention.map((server) => `mcp.home.needs.${server.id}`));
    expect(model.attention.map((server) => server.id).sort()).toEqual(['github', 'postgres']);

    // The fix leaves the legend: it says the amber word only, and its row opens the server.
    expect(screen.findByTestId('mcp.home.legend.postgres.fix')).toBeNull();
    await act(async () => { screen.findByTestId('mcp.home.needs.postgres.fix')!.props.onPress(); });
    expect(routerPush).toHaveBeenLastCalledWith('/settings/mcp/postgres');
    await act(async () => { screen.findByTestId('mcp.home.needs.github.fix')!.props.onPress(); });
    expect(routerPush).toHaveBeenLastCalledWith('/settings/mcp/github');
  });

  it('gives every row its own reason from the server\'s facts, never one sentence repeated', async () => {
    const docs = { ...entry('docs', 'oauth'), description: 'Library docs and code examples' } as McpServerCatalogEntryV1;
    const servers = [docs, entry('linear', 'oauth', 23), entry('sentry', 'oauth'), entry('notion', 'oauth'), entry('postgres', 'key')];
    const signIn: Record<string, McpSignInView> = {
      docs: { state: 'not_connected' }, linear: { state: 'not_connected' },
      sentry: { state: 'did_not_finish' }, notion: { state: 'no_machine_online' },
    };
    const model = buildMcpHome({
      rows: buildMcpServerCollection(settings(servers), ''),
      signInOf: (id) => signIn[id] ?? null,
      savedSecretCatalog: { resolveReference: (ref) => resolveSavedSecretReference(null, [], ref) },
      firstVisitDismissed: true,
    });
    const screen = await renderScreen(<McpServersHomeView home={{ ...homeData([], null), model }} />);
    const reason = (id: string) => screen.findAll((node) => node.props?.testID === `mcp.home.needs.${id}`
      && node.props.mark !== undefined)[0]!.props.description as string;
    expect(reason('docs')).toBe('Library docs and code examples');
    expect(reason('linear')).toContain('23 tools');
    expect(reason('sentry')).toBe('Sign-in is not complete. Try again when you’re ready.');
    expect(reason('notion')).toBe('A machine finishes the sign-in for you. None of yours is online right now.');
    expect(reason('postgres')).toContain('Authorization');
    const all = ['docs', 'linear', 'sentry', 'notion', 'postgres'].map(reason);
    expect(new Set(all).size).toBe(all.length);
  });

  it('draws no Needs you section when nothing needs the person', async () => {
    const screen = await renderScreen(
      <McpServersHomeView home={homeData([entry('fetch', 'local', 1), entry('brave', 'key')], null)} />,
    );
    expect(screen.findByTestId('mcp.home.needs')).toBeNull();
  });
});
