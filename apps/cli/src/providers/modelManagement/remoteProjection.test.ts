import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionRequestV1Schema, type DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

const transport = vi.hoisted(() => ({ call: vi.fn() }));
// The authenticated Machine RPC transport is the genuine network boundary.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: transport.call }));

import { createAccountScopedProviderCatalogReader, createAccountScopedProviderModelProjectionReader } from './remoteProjection';

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
  it('retains the requested saved connection when the source daemon returns an identityless failure', async () => {
    transport.call.mockReset().mockResolvedValue({ status: 'error', error: createProviderErrorV1('agent_error') });
    const read = createAccountScopedProviderModelProjectionReader({ serverUrl: 'https://home.example.test',
      readCredentials: async () => credentials, readAccountSettingsSnapshot: async () => snapshot, isCurrent: () => true });
    await expect(read(DaemonProviderModelProjectionRequestV1Schema.parse({ ...request, providerConnection: { connectionId: 'pc_actual',
      expectedConnectionSecurityFingerprint: 'connection-security:v1:source' } }), new AbortController().signal))
      .resolves.toMatchObject({ status: 'error', error: {
        code: 'agent_error', connectionId: 'pc_actual', machineId: request.machineId,
      } });
  });

  it('validates explicit hub catalog responses without falling back to another connection or Machine', async () => {
    transport.call.mockReset().mockResolvedValue({ status: 'success', connectionId: 'other-connection',
      connectionRevision: 1, manualModelPolicy: 'catalog-only', modelLoadAction: 'descriptor_absent', models: [] });
    const read = createAccountScopedProviderCatalogReader({ serverUrl: 'https://home.example.test',
      readCredentials: async () => credentials, readAccountSettingsSnapshot: async () => snapshot, isCurrent: () => true });
    const target = { machineId: 'hub-exact', connectionId: 'requested-connection' };
    await expect(read.models(target, new AbortController().signal)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_rpc_response_invalid' },
    });
    transport.call.mockResolvedValueOnce({ status: 'success', models: [] });
    await expect(read.probe(target, new AbortController().signal)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_rpc_response_invalid' },
    });
    expect(transport.call.mock.calls.map(([input]) => input.method)).toEqual([
      'daemon.providers.models', 'daemon.providers.probe',
    ]);
    expect(transport.call.mock.calls.every(([input]) => input.machineId === target.machineId)).toBe(true);
  });

  it('identifies transport cancellation without recording private transport failure content', async () => {
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const controller = new AbortController();
    const failure = new Error('private-transport-content');
    transport.call.mockReset().mockImplementation(async () => { controller.abort(failure); throw failure; });
    try {
      const read = createAccountScopedProviderModelProjectionReader({ serverUrl: 'https://home.example.test',
        readCredentials: async () => credentials, readAccountSettingsSnapshot: async () => snapshot, isCurrent: () => true });
      await expect(read(request, controller.signal)).rejects.toBe(failure);
      expect(logs.mock.calls).toContainEqual(['[PROVIDER] Remote model projection phase', expect.objectContaining({
        phase: 'machine_rpc', status: 'failed', reason: 'cancelled', machineId: request.machineId,
      })]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain('private-transport-content');
    } finally { logs.mockRestore(); }
  });

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
