import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AccountSettingsV2GetResponseSchema,
  CurrentCursorResponseSchema,
} from '@happier-dev/protocol';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { AppRailBotEntry } from '@/components/navigation/shell/appRail/appRailModel';

// The Account, ordinary list/index, Bot classification, rows and actions stay real. Only
// native/navigation adapters and the external transports are replaced.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const navigate = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { navigate } }).module);
// Metro's deferred require is the loader boundary; the real Action executor remains underneath it.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

installDisconnectedServerSocketBoundary();

// No Home here answers a structural Session query: the roster reads the ordinary loaded rows.
const features = createRootLayoutFeaturesResponse({
  features: { sessions: { enabled: true } },
});
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let persistedOrder: string[] | null = null;

describe('Bots roster', () => {
  beforeAll(loadSyncSingletonForTests);
  beforeEach(async () => {
    persistedOrder = null;
    navigate.mockClear();
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://bots-roster.example.test',
      serverIdentityId: 'srv_bots-roster',
      accountId: 'account-a',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v2/cursor')
          return Response.json(
            CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }),
          );
        if (path === '/v1/account/encryption/currentness')
          return Response.json(
            createPlainAccountEncryptionCurrentnessFixture(),
          );
        if (path === '/v1/account/encryption')
          return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/account/settings')
          return Response.json(
            AccountSettingsV2GetResponseSchema.parse({
              content: { t: 'plain', v: { hideInactiveSessions: true } },
              version: 1,
            }),
          );
        if (path === '/v2/session-organization/order') {
          const input = ReorderSessionOrganizationRequestSchema.parse(JSON.parse(String(init?.body)));
          persistedOrder = input.entries.map(entry => entry.itemKey);
          return Response.json({ orderEntries: input.entries.map(entry => ({ ...entry, scopeKind: input.scopeKind, scopeKey: input.scopeKey })) });
        }
        return new Response('{}', { status: 404 });
      },
    });
    primeServerFeaturesSnapshot({
      serverId: connection.home.id,
      snapshot: { status: 'ready', features },
    });
  });
  afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
  });

  it('lists every Bot, inactive ones too, as ordinary Session rows with New bot and Ask Happier beneath', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    storage.getState().applySettingsLocal({ hideInactiveSessions: true });
    storage
      .getState()
      .applyServerScopedSessionListRows(
        serverId,
        [
          createSessionListRenderableSessionFixture({
            id: 'inactive-bot',
            active: false,
            metadata: { path: '/project', bot: { kind: 'bot' } },
          }),
          createSessionListRenderableSessionFixture({
            id: 'active-bot',
            active: true,
            activeAt: now,
            updatedAt: now,
            metadata: { path: '/project', bot: { kind: 'bot' } },
          }),
          createSessionListRenderableSessionFixture({
            id: 'ordinary',
            active: true,
            activeAt: now,
            updatedAt: now,
            metadata: { path: '/project' },
          }),
        ],
        { source: 'ordinary', mode: 'replace' },
      );

    const close = vi.fn();
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={close} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    expect(screen.findByTestId('session-list-item-active-bot')).not.toBeNull();
    expect(
      screen.findByTestId('session-list-item-inactive-bot'),
    ).not.toBeNull();
    expect(screen.findByTestId('session-list-item-ordinary')).toBeNull();
    expect(screen.findByTestId('bots-roster.new-bot')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.ask-happier')).not.toBeNull();

    // Opening a Bot opens its Session and closes the roster that hosted it.
    await screen.pressByTestIdAsync('session-list-item-active-bot');
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify(navigate.mock.calls[0]?.[0])).toContain('active-bot');
  });

  it('invites a first Bot when there is none, without apologising', async () => {
    const serverId = connection!.home.id;
    storage
      .getState()
      .applyServerScopedSessionListRows(
        serverId,
        [
          createSessionListRenderableSessionFixture({
            id: 'ordinary',
            active: true,
            metadata: { path: '/project' },
          }),
        ],
        { source: 'ordinary', mode: 'replace' },
      );
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('bots-roster.empty')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.empty.new-bot')).not.toBeNull();
    expect(screen.findByTestId('session-list-item-ordinary')).toBeNull();
  });

  it('discloses ordinary child Sessions under a Bot using the server total and the shared local fold choice', async () => {
    const serverId = connection!.home.id;
    storage.getState().applyLocalSettings({ collapsedGroupKeysV1: {} });
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'lead-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        reports: { total: 9, working: 0, stalled: 0, needsYou: 0 } }),
      createSessionListRenderableSessionFixture({ id: 'child-session', metadata: { path: '/project' },
        reportsTo: { sessionId: 'lead-bot' } }),
      createSessionListRenderableSessionFixture({ id: 'child-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        reportsTo: { sessionId: 'lead-bot' } }),
      createSessionListRenderableSessionFixture({ id: 'unrelated', metadata: { path: '/project' } }),
    ], { source: 'ordinary', mode: 'replace' });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-row-reports-chip:lead-bot')).not.toBeNull();
    expect(screen.getTextContent()).toContain('9');
    expect(screen.findByTestId('session-list-item-child-session')).toBeNull();
    expect(screen.findByTestId('session-list-item-child-bot')).toBeNull();
    await screen.pressByTestIdAsync('session-row-reports-disclosure:lead-bot');
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-list-item-child-session')).not.toBeNull();
    expect(screen.findByTestId('session-list-item-child-bot')).not.toBeNull();
    expect(screen.findByTestId('session-list-item-unrelated')).toBeNull();
    await screen.pressByTestIdAsync('session-row-reports-disclosure:lead-bot');
    expect(screen.findByTestId('session-list-item-child-session')).toBeNull();
  });

  it('moves a rail Bot with the keyboard through qualified Action admission and the mounted organization writer', async () => {
    const serverId = connection!.home.id;
    const ids = ['first-bot', 'list-only', 'last-bot'];
    storage.getState().applyServerScopedSessionListRows(serverId, ids.map(id => createSessionListRenderableSessionFixture({
      id, metadata: { path: '/project', ...(id === 'list-only' ? {} : { bot: { kind: 'bot' as const } }) },
    })), { source: 'ordinary', mode: 'replace' });
    ids.forEach((sessionId, index) => {
      const record = storage.getState().setSessionPinOptimistic(serverId, sessionId, {
        sessionId, sortKey: null, pinnedAt: index, listPinned: true, railPinned: sessionId !== 'list-only',
      });
      storage.getState().commitSessionOrganizationOptimistic(record);
    });
    const bot: AppRailBotEntry = { id: 'bot-first', sessionId: 'first-bot', serverId, avatarId: 'first',
      session: createSessionListRenderableSessionFixture({ id: 'first-bot', metadata: { path: '/project', bot: { kind: 'bot' } } }) };
      const { AppRailBotPin } = await import('@/components/navigation/shell/appRail/AppRailBots');
      const { useSessionListRailOrganizationAction } = await import('@/components/sessions/shell/useSessionListRailOrganizationAction');
      function RailWithoutColumn() {
        useSessionListRailOrganizationAction([serverId]);
        return <AppRailBotPin bot={bot} animateEntry={false} slotStyle={{}} nextBotSessionId="last-bot" />;
      }
      const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <RailWithoutColumn />
      </InjectedAuthProvider>);
      await flushHookEffects({ cycles: 3 });
      const button = screen.findHostByTestId('app-rail:bot-first');
      expect(typeof button?.props.onKeyDown).toBe('function');
      await act(async () => {
        await button!.props.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() {}, stopPropagation() {} });
      });
      await flushHookEffects({ frames: 1 });
      expect(screen.findHostByTestId('app-rail:bot-first')?.props['aria-expanded']).toBe(true);
      await act(async () => { await button!.props.onKeyDown({ key: 'ArrowDown', altKey: true,
        preventDefault() {}, stopPropagation() {} }); });
      await flushHookEffects({ cycles: 3 });
      expect(persistedOrder).toEqual(['list-only', 'last-bot', 'first-bot']);
      expect(navigate).not.toHaveBeenCalled();
  });
});
