import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { createAccountServerWorkspaceWorkerPreferenceClient } from './workspaceWorkerPreferences';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

const workspace = { serverId: 'home-a', refId: 'checkout-a' };
const preference = { enabled: false as const, unavailable: 'ask' as const, allowAdHoc: false, scriptOverrides: {} };
const input = {
  token: 'account-token', credentials: { token: 'account-token' }, serverHttpBaseUrl: 'https://captured-home.test',
  context: { surface: 'cli' as const, serverId: 'home-a' }, actionId: 'projects.worker.preferences.set',
  resolveRequestHeaders: () => ({ Authorization: 'Bearer account-token' }),
};
const response = (data: unknown, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
afterEach(() => vi.restoreAllMocks());

describe('captured Account workspace preference carrier', () => {
  it('awaits requester HTTP authorization and keeps invocation settings independent of daemon Account retirement', async () => {
    let current = true;
    const credentials = { token: 'bob', encryption: null };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1,
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), settingsSecretsReadKeys: [] },
      serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: async () => current });
    const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(config.headers?.['x-requester-proof']).toBe('bob-proof');
      expect(config.headers?.Authorization).toBeUndefined();
      return response(config.url?.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference, allowAdHoc: true, services: {} } } });
    });
    const client = await createAccountServerWorkspaceWorkerPreferenceClient({ ...input, credentials, token: credentials.token,
      operationContext, resolveRequestHeaders: async () => ({ 'x-requester-proof': 'bob-proof' }) });
    expect(client).not.toBeNull();
    clearActiveAccountSettingsSnapshot();
    expect(await client!.get({ workspace })).toMatchObject({ status: 'ready', preference: { allowAdHoc: true } });
    current = false;
    const requestsBeforeRetirement = request.mock.calls.length;
    expect(await client!.get({ workspace })).toEqual({ status: 'unavailable' });
    expect(request.mock.calls.length).toBe(requestsBeforeRetirement);
  });

  it('keeps Plain keyless, addresses the exact checkout and observes a committed lost acknowledgement once', async () => {
    let row: unknown = null;
    let writes = 0;
    const request = vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      expect(config.headers?.Authorization).toBe('Bearer account-token');
      expect(config.url?.startsWith(input.serverHttpBaseUrl)).toBe(true);
      if (config.url?.endsWith('/v1/account/encryption')) return response({ mode: 'plain', updatedAt: 1 });
      expect(config.url).toContain(WORKSPACE_EXECUTION_CONFIG_ROUTE_V1);
      expect(config.data.address).toEqual(workspace);
      if (config.url?.endsWith('/read')) return response(row === null ? { status: 'absent' }
        : { status: 'present', revision: 1, content: row });
      writes++;
      row = config.data.content;
      throw new Error('committed then disconnected');
    });
    const client = await createAccountServerWorkspaceWorkerPreferenceClient(input);
    expect(client).not.toBeNull();
    const next = { ...preference, allowAdHoc: true };
    expect(await client!.set({ workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next }))
      .toEqual({ status: 'satisfied', preference: next, provenance: 'saved', revision: 1 });
    expect(row).toEqual({ t: 'plain', v: { ...next, services: {} } });
    expect(writes).toBe(1);
    expect(request.mock.calls.filter(([config]) => config.url?.endsWith('/mutate'))).toHaveLength(1);
  });

  it('withdraws late rows and prevents mutation after the captured credential retires', async () => {
    let current = true;
    let writes = 0;
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.url?.endsWith('/v1/account/encryption')) return response({ mode: 'plain', updatedAt: 1 });
      if (config.url?.endsWith('/mutate')) writes++;
      current = false;
      return response({ status: 'present', revision: 1, content: { t: 'plain', v: { ...preference, allowAdHoc: true, services: {} } } });
    });
    const client = await createAccountServerWorkspaceWorkerPreferenceClient({ ...input, isCredentialCurrent: () => current });
    expect(await client!.get({ workspace })).toEqual({ status: 'unavailable' });
    expect(await client!.set({ workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next: preference }))
      .toEqual({ status: 'cancelled' });
    expect(writes).toBe(0);
  });

  it('refuses unknown Account mode and missing E2EE material before reading or defaulting config', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValue(response({ mode: 'invalid', updatedAt: 1 }));
    expect(await createAccountServerWorkspaceWorkerPreferenceClient(input)).toBeNull();
    request.mockResolvedValue(response({ mode: 'e2ee', updatedAt: 1 }));
    const client = await createAccountServerWorkspaceWorkerPreferenceClient(input);
    expect(await client!.get({ workspace })).toEqual({ status: 'locked' });
    expect(request.mock.calls.every(([config]) => config.url?.endsWith('/v1/account/encryption'))).toBe(true);
  });
});
