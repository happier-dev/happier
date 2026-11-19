import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
  NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
  NotificationChannelRecordV1Schema,
} from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import * as persistence from '@/persistence';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import {
  bindApiSessionSocketPairMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
// Only the network transports are replaced; the Session client, its change sync and the catalog owners stay real.
vi.mock('socket.io-client', () => ({ io: mockIo }));

describe('Session client Account catalog convergence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('re-reads a demanded notification channel catalog when its Account row changes', async () => {
    const testHome = await mkdtemp(
      join(tmpdir(), 'happier-notification-catalog-change-'),
    );
    vi.stubEnv('HAPPIER_HOME_DIR', testHome);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { ApiSessionClient } = await import('@/api/session/sessionClient');
    const sessionSocket = createApiSessionSocketStub();
    const userSocket = createApiSessionSocketStub();
    bindApiSessionSocketPairMock(mockIo, {
      sessionSocket,
      userSocket,
      fallbackSocket: sessionSocket,
    });
    const credentials = {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'catalog-change-account' })).toString('base64url')}.signature`,
      encryption: null,
    };
    // A turn earlier in this runner hydrated the channel catalog before the person added a webhook.
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 7,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: {
        status: 'ready',
        revision: 1,
        diagnostics: [],
        channels: [],
      },
    });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(
      credentials,
    );
    const webhook = NotificationChannelRecordV1Schema.parse({
      v: 1,
      id: 'added-webhook',
      kind: 'webhook',
      enabled: true,
      topics: { ready: true },
      url: 'https://hooks.example.test/ready',
      signingSecretRef: null,
    });
    vi.spyOn(axios, 'get').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/account/profile')
        return { status: 200, data: { id: 'catalog-change-account' } };
      if (url.pathname.includes('changes'))
        return {
          status: 200,
          data: {
            nextCursor: 9,
            changes: [
              {
                cursor: 9,
                kind: 'account',
                entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
                changedAt: 2,
              },
            ],
          },
        };
      if (url.pathname === '/v1/account/encryption/currentness')
        return {
          status: 200,
          data: {
            mode: 'plain',
            version: 1,
            settingsVersion: 7,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
          },
        };
      if (url.pathname === '/v1/account/entity-rows/notification-channels')
        return {
          status: 200,
          data: {
            status: 'present',
            revision: 2,
            content: { t: 'plain', v: { v: 1, channels: [webhook] } },
          },
        };
      if (url.pathname === '/v2/account/settings')
        return {
          status: 200,
          data: { version: 7, content: { t: 'plain', v: {} } },
        };
      if (url.pathname === '/v1/account/saved-secrets/resources/materials')
        return { status: 200, data: { resources: [] } };
      const empty = emptyAccountSettingsHistoryCaptureResponse(url.pathname);
      if (empty) return empty;
      return { status: 404, data: {} };
    });
    const client = createTestApiSessionClient(
      ApiSessionClient,
      credentials.token,
      createPlainSessionFixture({ id: 'catalog-change' }),
    );
    try {
      // The live Account change hint, as the shared update connection delivers it.
      await (
        client as unknown as {
          recoveryRuntime: {
            syncChangesOnConnect(opts: { reason: 'live' }): Promise<void>;
          };
        }
      ).recoveryRuntime.syncChangesOnConnect({ reason: 'live' });

      await vi.waitFor(() =>
        expect(
          getActiveAccountSettingsSnapshot()?.notificationChannelCatalog,
        ).toMatchObject({
          status: 'ready',
          channels: [
            expect.objectContaining({ id: 'added-webhook', kind: 'webhook' }),
          ],
        }),
      );
    } finally {
      await client.close();
      await rm(testHome, { recursive: true, force: true });
    }
  });
});
