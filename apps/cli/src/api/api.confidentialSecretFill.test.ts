import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, type ActionExecutorDeps } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { createBrowserAutomationCdpAdapter } from '@/daemon/browser/automation/adapters/cdp';
import { createBrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import { createBrowserAutomationDaemonService } from '@/daemon/browser/automation/service';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ApiClient } from './api';
import { createComputerRoutes } from '@/daemon/computer/routes';
import { createMachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';

// The authenticated Home HTTP boundary supplies current mode. API, materializer,
// Browser route/service and shared input-control logic remain real.
vi.mock('axios', () => ({ default: {
  // The real credential decorator reads Axios defaults before invoking the HTTP boundary.
  defaults: {},
  get: async () => ({ status: 200, data: { mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }),
  isAxiosError: () => false,
}, isAxiosError: () => false }));

afterEach(resetActiveAccountSettingsSnapshotForTests);

describe('ApiClient confidential target preparation', () => {
  it('does not route deferred native fill to a registered computer handler', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const api = await ApiClient.create({ token, encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    api.setComputerRoutesProvider(() => routes);
    try {
      expect(await api.createBrowserRuntimeActionExecutor()({
        actionId: 'computer.secret.fill', input: {},
        context: { authority: 'present_user', defaultSessionId: 'session' },
      })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    } finally { await routes.dispose(); }
  });

  it.each([
    { qualified: true },
    { qualified: false },
  ])('delivers only qualified Browser fills ($qualified)', async ({ qualified }) => {
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
        fill: async (bytes) => {
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
    const scope = { serverId: configuration.activeServerId, machineId: 'machine', sessionId: 'session', purpose: 'Sign in' };
    const binding = {
      actionId: 'browser.automation.secret.fill' as const,
      request: { ...scope,
        ...view, tabId: 'tab', frameId: 'frame', documentId: 'document', navigationGeneration: 0,
        origin: 'https://example.test', field: { fieldId: '1', focusId: '1', locator: '#password' },
      },
    };
    const args: Parameters<NonNullable<ActionExecutorDeps['confidentialSecretFill']>>[0] = {
      ...binding,
      choice: { kind: 'once', value: 'D26-API-FIXTURE' }, submit: false, accountEncryptionMode: 'plain',
      context: { authority: 'present_user', runtimeAccountId: 'account', serverIdentityId: 'verified-home' },
      isCurrent: async () => true,
    };
    try {
      const result = await execute(args);
      expect(result).toEqual(qualified ? { status: 'filled', code: 'filled' }
          : { status: 'refused', code: 'observation_unavailable' });
      expect(JSON.stringify(result)).not.toContain('D26-API-FIXTURE');
      expect(effects).toEqual(qualified ? ['D26-API-FIXTURE', 'finished'] : ['finished']);
    } finally { service.dispose(); }
  });
});
