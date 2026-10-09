import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, type ActionExecutorDeps } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { createBrowserAutomationCdpAdapter } from '@/daemon/browser/automation/adapters/cdp';
import { createBrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import { createBrowserAutomationDaemonService } from '@/daemon/browser/automation/service';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ApiClient } from './api';

// The authenticated Home HTTP boundary supplies current mode. API, materializer,
// Browser route/service and shared input-control logic remain real.
vi.mock('axios', () => ({ default: {
  get: async () => ({ status: 200, data: { mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }),
  isAxiosError: () => false,
}, isAxiosError: () => false }));

afterEach(resetActiveAccountSettingsSnapshotForTests);

describe('ApiClient confidential Browser preparation', () => {
  it.each([true, false])('delivers only producer-qualified headless fills without requiring native containment (qualified=%s)', async qualified => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    const view = { browserSessionId: 'browser', viewId: 'view' };
    const effects: string[] = [];
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: () => true,
      dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
      dispatchPageQuery: async () => ({ ok: true }),
      // The physical transport is the only Browser boundary substituted here.
      prepareConfidentialFill: async () => ({
        ...(qualified ? { nativeObservation: 'not_observable' as const } : {}),
        recheck: async () => true,
        fill: async (bytes, _signal, beforeDelivery) => {
          if (beforeDelivery && !await beforeDelivery()) return { status: 'refused', code: 'approval_changed' };
          effects.push(Buffer.from(bytes).toString('utf8'));
          return { status: 'filled', code: 'filled' };
        },
        finish: async () => { effects.push('finished'); },
      }),
    } }) });
    api.setBrowserDaemonAutomationRoutesProvider(() => createBrowserAutomationRoutes({ service }));
    setActiveAccountSettingsSnapshot({ source: 'network', loadedAtMs: 1, settingsVersion: 1,
      settingsSecretsReadKeys: [], settings: AccountSettingsSchema.parse({}),
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    const preparation = {
      machineId: () => 'machine',
      readHostIdentity: async () => ({ serverIdentityId: 'verified-home', machineId: 'machine' }),
    };
    const execute = api.createConfidentialSecretFillExecutor(preparation);
    const args: Parameters<NonNullable<ActionExecutorDeps['confidentialSecretFill']>>[0] = {
      actionId: 'browser.automation.secret.fill',
      request: { serverId: configuration.activeServerId, machineId: 'machine', sessionId: 'session', purpose: 'Sign in',
        ...view, tabId: 'tab', frameId: 'frame', documentId: 'document', navigationGeneration: 0,
        origin: 'https://example.test', field: { fieldId: '1', focusId: '1', locator: '#password' },
      },
      choice: { kind: 'once', value: 'D26-API-FIXTURE' }, submit: false, accountEncryptionMode: 'plain',
      context: { authority: 'present_user', runtimeAccountId: 'account', serverIdentityId: 'verified-home' },
      isCurrent: async () => true,
    };
    try {
      expect(await execute(args)).toEqual(qualified
        ? { status: 'filled', code: 'filled' }
        : { status: 'refused', code: 'observation_unavailable' });
      expect(effects).toEqual(qualified ? ['D26-API-FIXTURE', 'finished'] : ['finished']);
    } finally { service.dispose(); }
  });
});
