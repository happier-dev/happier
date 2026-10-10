import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

const transport = vi.hoisted(() => ({ call: vi.fn() }));
// The authenticated Machine RPC transport is the genuine network boundary.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: transport.call }));

import { createAccountScopedProviderModelProjectionReader } from './remoteProjection';

const request = {
  machineId: 'hub-exact', agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
} satisfies DaemonProviderModelProjectionRequestV1;
const response = { status: 'success', agentTargetKey: request.agentTargetKey, groups: [] };
const credentials: StoredCredentials = {
  token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.fixture`,
  encryption: null,
};
const snapshot: ActiveAccountSettingsSnapshot = {
  source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
  loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
};

describe('Account-scoped remote Provider projection transport', () => {
  it('uses only the captured Home and exact persistent hub with the owning Account', async () => {
    transport.call.mockReset().mockResolvedValue(response);
    const read = createAccountScopedProviderModelProjectionReader({
      serverUrl: 'https://home.example.test', readCredentials: async () => credentials,
      readAccountSettingsSnapshot: async () => snapshot, isCurrent: () => true,
    });
    const signal = new AbortController().signal;
    await expect(read(request, signal)).resolves.toEqual(response);
    expect(transport.call).toHaveBeenCalledWith(expect.objectContaining({
      credentials, serverUrl: 'https://home.example.test', machineId: 'hub-exact',
      requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null, signal,
      method: 'daemon.providers.model.projection', request,
    }));
  });

  it('refuses a foreign Account before transport and withdrawn authority after an awaited response', async () => {
    transport.call.mockReset().mockResolvedValue(response);
    let currentSnapshot: ActiveAccountSettingsSnapshot | null = { ...snapshot, scopeKey: 'foreign-account' };
    const read = createAccountScopedProviderModelProjectionReader({
      serverUrl: 'https://home.example.test', readCredentials: async () => credentials,
      readAccountSettingsSnapshot: async () => currentSnapshot, isCurrent: () => true,
    });
    await expect(read(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(transport.call).not.toHaveBeenCalled();
    currentSnapshot = snapshot;
    transport.call.mockImplementationOnce(async () => {
      currentSnapshot = null;
      return response;
    });
    await expect(read(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
  });

  it('never retries another machine or discloses a response for another Agent target', async () => {
    transport.call.mockReset().mockResolvedValue({ ...response, agentTargetKey: 'agent:happier.agent.claude/claude' });
    const read = createAccountScopedProviderModelProjectionReader({
      serverUrl: 'https://home.example.test', readCredentials: async () => credentials,
      readAccountSettingsSnapshot: async () => snapshot, isCurrent: () => true,
    });
    await expect(read(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_rpc_response_invalid' },
    });
    expect(transport.call).toHaveBeenCalledTimes(1);
  });
});
