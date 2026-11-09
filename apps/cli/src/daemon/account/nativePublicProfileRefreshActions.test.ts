import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { captureNativePublicProfileRefresh } from './nativePublicProfileRefreshActions';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createNativePublicProfileRefreshFixture } from './publicProfileRefresh.testkit';

describe('native public-profile Account Action adapter', () => {
  const fixtures: Awaited<ReturnType<typeof createNativePublicProfileRefreshFixture>>[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
    resetActiveAccountSettingsSnapshotForTests();
  });
  const context = () => ({ surface: 'cli' as const, signal: new AbortController().signal });
  async function fixture(settings: unknown) {
    const account = await createNativePublicProfileRefreshFixture({ computedAtMs: null, settings });
    fixtures.push(account);
    return account;
  }

  it.each(['clear', 'scope', 'keys'] as const)('keeps native refresh alive through unrelated preferences and retires it once on %s withdrawal', async withdrawal => {
    const credentials = { token: 'native-refresh-test', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, settings: accountSettingsParse({}),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const controller = new AbortController();
    const refresh = await captureNativePublicProfileRefresh({ credentials, signal: controller.signal,
      serverId: 'test', serverHttpBaseUrl: 'https://home.test', resolveServerFeaturesSnapshot: () => undefined });
    const retired = vi.fn();
    refresh.signal.addEventListener('abort', retired);
    try {
      for (let index = 0; index < 25; index++) {
        const current = getActiveAccountSettingsSnapshot()!;
        setActiveAccountSettingsSnapshot({ ...current, settingsVersion: current.settingsVersion + 1,
          settings: { ...current.settings, analyticsOptOut: index % 2 === 0 } });
      }
      expect(retired).toHaveBeenCalledTimes(0);
      const current = getActiveAccountSettingsSnapshot()!;
      if (withdrawal === 'clear') clearActiveAccountSettingsSnapshot();
      else setActiveAccountSettingsSnapshot({ ...current, settingsVersion: current.settingsVersion + 1,
        ...(withdrawal === 'scope' ? { scopeKey: 'replacement-account' } : { settingsSecretsReadKeys: [new Uint8Array([1])] }) });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(refresh.signal.aborted).toBe(true);
    } finally { controller.abort(); }
  });

  it.each([
    { policy: { v: 1, actions: { 'account.public_profile.refresh': { enabled: false } } }, code: 'action_disabled' },
    { policy: { v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] },
      actions: { 'account.public_profile.refresh': { approvalRequiredSurfaces: ['cli'] } } }, code: 'action_interactive_review_required' },
  ])('refuses $code through canonical CLI policy without creating a background approval or writing facts', async ({ policy, code }) => {
    const f = await fixture(policy);
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: false, errorCode: code });
    expect(f.refreshes).toEqual([]);
    expect(f.requests.filter(request => request.method !== 'GET' && !['/v2/usage/query', '/v2/sessions/read-batch'].includes(request.path))).toEqual([]);
  });

  it('runs default Allowed CLI refresh through real Usage computation and acknowledges only the facts-only HTTP snapshot effect', async () => {
    const f = await fixture({ v: 1 });
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: true,
      result: { kind: 'updated', record: { state: 'published', snapshot: { facts: { tokens: 10 } } } } });
    expect(f.refreshes).toHaveLength(1);
    expect(Object.keys(f.refreshes[0]!).sort()).toEqual(['query', 'snapshot']);
    expect(f.requests.filter(request => request.method !== 'GET' && !['/v2/usage/query', '/v2/sessions/read-batch'].includes(request.path))).toEqual([
      { method: 'PUT', path: '/v1/account/public-profile/snapshot' },
    ]);
  });

  it('returns the shared typed refusal when the real Usage HTTP source is unavailable', async () => {
    const f = await fixture({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] } });
    f.setUsageAvailable(false);
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: false,
      errorCode: 'public_profile_preparation_unavailable', details: { reason: 'usage_unavailable' } });
    expect(f.refreshes).toEqual([]);
  });
});
