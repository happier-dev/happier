import 'fake-indexeddb/auto';
import * as React from 'react';
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

import {
  createPlainAccountEncryptionCurrentnessFixture,
  createRootLayoutFeaturesResponse,
  createSessionListRenderableSessionFixture,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';

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

installDisconnectedServerSocketBoundary();

// No Home here answers a structural Session query: the roster reads the ordinary loaded rows.
const features = createRootLayoutFeaturesResponse({
  features: { sessions: { enabled: true } },
});
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;

describe('Bots roster', () => {
  beforeAll(loadSyncSingletonForTests);
  beforeEach(async () => {
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://bots-roster.example.test',
      serverIdentityId: 'srv_bots-roster',
      accountId: 'account-a',
      request: async (url) => {
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
});
