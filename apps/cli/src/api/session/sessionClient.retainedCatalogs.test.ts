import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
  NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
} from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import { buildProfilePhysicalKey, PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ReadableApprovalProfileV1Schema } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { runAddedHostedSession, bindToHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { ApiSessionClient } from '@/api/session/sessionClient';
import * as persistence from '@/persistence';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
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

describe('Session client retained Account catalogs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it.each([
    { field: 'profileCatalog', entityId: buildProfilePhysicalKey('changed-profile'), path: '/v1/account/entity-rows/profiles', expected: { status: 'ready', referenceGuardRevision: 3 } },
    { field: 'providerConnectionsCatalog', entityId: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, path: '/v1/account/entity-rows/provider-connections', expected: { status: 'ready', revision: 2 } },
    { field: 'approvalProfileCatalog', entityId: 'deleted-approval', path: '/v1/artifacts', expected: [] },
    { field: 'notificationChannelCatalog', entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, path: '/v1/account/entity-rows/notification-channels', expected: { status: 'ready', revision: 2 }, reason: 'connect' as const },
  ] as const)('refreshes $field on its change or a late connect', async (testCase) => {
    const foreignWake = vi.fn();
    const foreign = await runAddedHostedSession({ environment: {}, workingDirectory: '/foreign', end() {} }, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'foreign-account', settings: accountSettingsParse({}),
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [] } });
      subscribeActiveAccountSettingsSnapshot(foreignWake);
      const snapshot = getActiveAccountSettingsSnapshot();
      return { snapshot, read: bindToHostedSessionScope(() => getActiveAccountSettingsSnapshot()) };
    });
    await runAddedHostedSession({ environment: {}, workingDirectory: '/owner', end() {} }, async () => {
      const testHome = await mkdtemp(
        join(tmpdir(), 'happier-notification-catalog-change-'),
      );
      vi.stubEnv('HAPPIER_HOME_DIR', testHome);
      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();
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
        ...(testCase.field === 'notificationChannelCatalog' ? { notificationChannelCatalog: { status: 'ready' as const, revision: 1, diagnostics: [], channels: [] } }
          : testCase.field === 'providerConnectionsCatalog' ? { providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } }
          : testCase.field === 'approvalProfileCatalog' ? { approvalProfileCatalog: [ReadableApprovalProfileV1Schema.parse({ id: 'deleted-approval', profile: { id: 'deleted-approval', name: 'Deleted' }, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } })] }
          : { profileCatalog: { status: 'ready' as const, records: [], diagnostics: [], referenceGuardRevision: 1, authority: 'inactive' as const, control: null, controlRevision: 'absent' as const } }),
      });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(
        credentials,
      );
      let unrelated = false;
      let catalogReads = 0;
      vi.spyOn(axios, 'get').mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === testCase.path) catalogReads++;
        if (url.pathname === '/v1/account/profile')
          return { status: 200, data: { id: 'catalog-change-account' } };
        if (url.pathname.includes('changes'))
          return {
            status: 200,
            data: {
              nextCursor: 9,
              changes: 'reason' in testCase ? [] : unrelated ? [{ cursor: 10, kind: 'account', entityId: 'unrelated', changedAt: 3 }] : [
                {
                  cursor: 9,
                  kind: testCase.field === 'approvalProfileCatalog' ? 'artifact' : 'account',
                  entityId: testCase.entityId,
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
        if (url.pathname === '/v1/artifacts') return { status: 200, data: { items: [], hasUnclassified: false, coverage: 'complete' } };
        if (url.pathname === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } } };
        if (url.pathname.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 3 } };
        if (url.pathname === testCase.path) return { status: 200, data: { status: 'deleted', revision: 2 } };
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
      const checkConvergence = async () => {
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
                syncChangesOnConnect(opts: { reason: 'live' | 'connect' }): Promise<void>;
              };
            }
          ).recoveryRuntime.syncChangesOnConnect({ reason: 'reason' in testCase ? testCase.reason : 'live' });

          await vi.waitFor(() =>
            expect(
              getActiveAccountSettingsSnapshot()?.[testCase.field],
            ).toMatchObject(testCase.expected),
          );
          expect(catalogReads).toBeGreaterThan(0);
          expect(foreign.read()).toBe(foreign.snapshot);
          expect(foreignWake).not.toHaveBeenCalled();
          const settledReads = catalogReads;
          unrelated = true;
          for (let index = 0; index < 3; index++) {
            await (client as unknown as { recoveryRuntime: { syncChangesOnConnect(opts: { reason: 'live' }): Promise<void> } }).recoveryRuntime.syncChangesOnConnect({ reason: 'live' });
          }
          expect(catalogReads).toBe(settledReads);
        } finally {
          await client.close();
        }
      };
      try {
        if ('reason' in testCase) {
          const retained = getActiveAccountSettingsSnapshot()!;
          await runAddedHostedSession({ environment: {}, workingDirectory: '/later-owner', end() {} }, async () => {
            // Ordinary same-Account bootstrap retains the old Account facet in the host.
            const { notificationChannelCatalog: _catalog, ...bootstrap } = retained;
            setActiveAccountSettingsSnapshot(bootstrap);
            expect(getActiveAccountSettingsSnapshot()?.notificationChannelCatalog).toBe(retained.notificationChannelCatalog);
            await checkConvergence();
          });
        } else await checkConvergence();
      } finally {
        await rm(testHome, { recursive: true, force: true });
      }
    });
  });
});
