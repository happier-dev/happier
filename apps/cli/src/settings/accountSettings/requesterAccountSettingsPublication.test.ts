import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from './accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterAccountSettingsPublication } from './requesterAccountSettingsPublication';

afterEach(() => vi.restoreAllMocks());

it('publishes no refresh, quota or authorization wakes for unrelated writes and one for each consumed change', async () => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-observer' })).toString('base64url')}.fixture`;
  const serverHttpBaseUrl = 'https://settings-observer.test';
  // Only the Home HTTP and socket transport are substituted; publication,
  // decryption admission and captured Account state run through their real owners.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (new URL(String(url)).pathname.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    throw new Error('Unexpected Home request');
  });
  const channel = await createRequesterCurrentnessSocketHarness();
  const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: 'settings-observer', token, serverBaseUrl: serverHttpBaseUrl });
  let publication: ReturnType<typeof createRequesterAccountSettingsPublication> | undefined;
  const releases: (() => void)[] = [];
  try {
    const currentness = await observation.read();
    await channel.settleTransport();
    const context = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: { token, encryption: null }, serverHttpBaseUrl,
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) },
      isCurrent: async () => observation.isCurrent(currentness),
    }));
    publication = createRequesterAccountSettingsPublication({ observation, currentness, operationContext: context });
    const wakes = { refresh: 0, quota: 0, authorize: 0 };
    let quotaEnabled = false;
    let refreshed = false;
    let providerDefaults: unknown;
    releases.push(publication.subscribe(() => {
      wakes.refresh++;
      refreshed = context.readSnapshot()?.settings.connectedServicesProviderStateSharingSettingsV1.defaults.stateMode === 'isolated';
    }, { settings: ['connectedServicesProviderStateSharingSettingsV1'] }));
    releases.push(publication.subscribe(() => {
      wakes.quota++;
      quotaEnabled = context.readSnapshot()?.settings.usageQuotaNotificationsV1.pace === true;
    }, { settings: ['usageQuotaNotificationsV1'] }));
    releases.push(publication.subscribe(() => {
      wakes.authorize++;
      providerDefaults = context.readSnapshot()?.settings.providerDefaultModelSelectionsByAgentTargetKeyV1;
    }, { settings: ['providerDefaultModelSelectionsByAgentTargetKeyV1'], facets: ['providerConnectionsCatalog'] }));
    let version = 1;
    const push = async (settings: Record<string, unknown>) => {
      await channel.pushSettings('settings-observer', settings, ++version);
      expect(await publication!.ensureCurrent()).toBe(true);
      expect(context.readSnapshot()?.settingsVersion).toBe(version);
    };
    for (let index = 0; index < 25; index++) await push({ analyticsOptOut: index % 2 === 0 });
    expect(wakes).toEqual({ refresh: 0, quota: 0, authorize: 0 });
    const raw = { analyticsOptOut: true, usageQuotaNotificationsV1: { ...context.readSnapshot()!.settings.usageQuotaNotificationsV1, pace: true } };
    await push(raw);
    expect(wakes).toEqual({ refresh: 0, quota: 1, authorize: 0 });
    expect(quotaEnabled).toBe(true);
    await push(raw);
    expect(wakes.quota).toBe(1);
    await push({ ...raw, connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' } } });
    expect(wakes.refresh).toBe(1);
    expect(refreshed).toBe(true);
    // Independent Provider authority must still withdraw even without a Settings revision.
    expect(await context.commitProviderConnectionsCatalog({ expectedSettingsVersion: version,
      catalog: { status: 'unavailable', reason: 'scope-retired' } })).toBe(true);
    expect(wakes.authorize).toBe(1);
    expect(providerDefaults).toEqual(context.readSnapshot()?.settings.providerDefaultModelSelectionsByAgentTargetKeyV1);
  } finally {
    releases.forEach(release => release());
    publication?.dispose();
    await observation.dispose();
    await channel.close();
  }
});

it('recovers a reconnect Settings floor from one fresh Account witness and reuses it for warm readers', async () => {
  const accountId = 'settings-recovery-observer';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
  const serverHttpBaseUrl = 'https://settings-recovery.test';
  let settingsVersion = 1;
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: settingsVersion, settingsVersion,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (path === '/v2/account/settings') return { status: 200, data: {
      content: { t: 'plain', v: { analyticsOptOut: true } }, version: settingsVersion,
    } };
    throw new Error('Unexpected Home request');
  });
  const channel = await createRequesterCurrentnessSocketHarness();
  const observation = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: serverHttpBaseUrl });
  let publication: ReturnType<typeof createRequesterAccountSettingsPublication> | undefined;
  try {
    const currentness = await observation.read();
    await channel.settleTransport();
    const context = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: { token, encryption: null }, serverHttpBaseUrl,
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) },
      isCurrent: async () => observation.isCurrent(currentness),
    }));
    publication = createRequesterAccountSettingsPublication({ observation, currentness, operationContext: context });
    await channel.disconnect();
    settingsVersion = 3;
    await channel.reconnect();
    expect(await publication.ensureCurrent()).toBe(true);
    expect(context.readSnapshot()).toMatchObject({ settingsVersion: 3, settings: { analyticsOptOut: true } });
    for (let read = 0; read < 5; read++) expect(await publication.ensureCurrent()).toBe(true);
    expect(get.mock.calls.filter(([url]) => String(url).endsWith('/currentness'))).toHaveLength(2);
    expect(get.mock.calls.filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(1);
  } finally {
    publication?.dispose();
    await observation.dispose();
    await channel.close();
  }
});
