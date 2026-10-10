import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginPermissionSubjectV1Schema } from '@happier-dev/protocol';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import {
  createAccountLifetimePluginPermissionGrantListReader,
  createServerPluginPermissionGrantListReader,
  resetAccountLifetimePluginPermissionGrantProjectionForTests,
  retireAccountLifetimePluginPermissionGrant,
  retireAccountLifetimePluginPermissionGrantsForPlugin,
} from './pluginPermissionGrantListReader';

vi.mock('axios');
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: vi.fn(),
}));

describe('server plugin permission grant list reader', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockReset();
    vi.mocked(axios.isAxiosError).mockImplementation((error) => (
      error instanceof Error && error.message === 'relay unavailable'
    ));
    resetAccountLifetimePluginPermissionGrantProjectionForTests();
  });

  it('keeps a cold authoritative read pending past the session-control deadline', async () => {
    vi.useFakeTimers();
    try {
      const output = { grants: [{
        v: 1, id: 'late-grant', accountId: 'account-1', pluginId: 'acme.voice',
        capability: 'reviews.comments.write.direct', targetScope: { kind: 'account' }, subject: { kind: 'general' },
        authoritySource: { kind: 'bundled' }, status: 'active', grantedByUserId: 'user-1',
        grantedAt: 1, createdAt: 1, updatedAt: 1,
      }], pendingRequests: [] };
      vi.mocked(axios.post).mockImplementation(async (_url, _body, config) => new Promise((resolve, reject) => {
        const timeout = config?.timeout && config.timeout > 0
          ? setTimeout(() => reject(new Error('relay unavailable')), config.timeout) : undefined;
        setTimeout(() => { clearTimeout(timeout); resolve({ data: output }); }, 61_000);
      }));
      const reader = createAccountLifetimePluginPermissionGrantListReader({
        credentials: { token: 'account-token', encryption: null },
        getScopeKey: () => 'cold-account', getLifetimeToken: () => 1,
      });
      let settled = false;
      const pending = reader.list({ includeRevoked: false, includeResolvedRequests: false, limit: 50 })
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(await pending).toEqual(output);
    } finally { vi.useRealTimers(); }
  });

  it('posts the exact canonical query with account authentication and parses the response', async () => {
    const subject = PluginPermissionSubjectV1Schema.parse({
      kind: 'credential_access_disclosure',
      contribution: { pluginId: 'acme.voice', localId: 'speech' },
      credentialSlotId: 'api_key',
      purpose: 'voice.speech',
      accessDeclarationDigest: 'c'.repeat(64),
      selectedAuthorityDigest: 'd'.repeat(64),
      selectedRawAccessDigest: 'e'.repeat(64),
    });
    const output = {
      grants: [{
        v: 1,
        id: 'grant-1',
        accountId: 'account-1',
        pluginId: 'acme.voice',
        capability: 'credentials.materialize.raw',
        targetScope: { kind: 'account' },
        subject,
        authoritySource: { kind: 'bundled' },
        status: 'active',
        grantedByUserId: 'user-1',
        grantedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      pendingRequests: [],
    } as const;
    vi.mocked(axios.post).mockResolvedValue({ data: output });
    const controller = new AbortController();
    const reader = createServerPluginPermissionGrantListReader({
      credentials: { token: 'account-token' } as never,
    });
    const query = {
      pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
      caller: {
        pluginId: 'acme.voice',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
    } as const;
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockResolvedValue('publisher-proof');

    await expect(reader.list(query, { signal: controller.signal })).resolves.toEqual(output);
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/plugins/permissions/grants/list',
      body: query,
    });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/list$/u),
      query,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer account-token',
          'x-happier-plugin-installation-manifest-publisher': 'publisher-proof',
        }),
        signal: controller.signal,
      }),
    );
  });

  it('does not send caller provenance when the matching publisher proof is unavailable', async () => {
    const reader = createServerPluginPermissionGrantListReader({
      credentials: { token: 'account-token' } as never,
    });

    await expect(reader.list({
      pluginId: 'acme.voice',
      caller: {
        pluginId: 'acme.voice',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 50,
    })).rejects.toThrow('plugin_permission_grant_publisher_proof_unavailable');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('reuses a synchronized active grant only during the same Account lifetime when the relay is unavailable', async () => {
    const subject = PluginPermissionSubjectV1Schema.parse({
      kind: 'credential_access_disclosure',
      contribution: { pluginId: 'acme.voice', localId: 'speech' },
      credentialSlotId: 'api_key',
      purpose: 'voice.speech',
      accessDeclarationDigest: 'c'.repeat(64),
      selectedAuthorityDigest: 'd'.repeat(64),
      selectedRawAccessDigest: 'e'.repeat(64),
    });
    const grant = {
      v: 1,
      id: 'grant-1',
      accountId: 'account-1',
      pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      authoritySource: { kind: 'machine_installation', machineId: 'machine-1', installationId: 'install-1' },
      status: 'active',
      grantedByUserId: 'user-1',
      grantedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    let lifetime = 1;
    let scopeKey: string | null = 'account-scope-1';
    const reader = createAccountLifetimePluginPermissionGrantListReader({
      credentials: { token: 'account-token', encryption: null },
      getScopeKey: () => scopeKey,
      getLifetimeToken: () => lifetime,
    });
    const query = {
      pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    } as const;
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { grants: [grant], pendingRequests: [] } });
    await expect(reader.list(query)).resolves.toEqual({ grants: [grant], pendingRequests: [] });

    vi.mocked(axios.post).mockRejectedValue(new Error('relay unavailable'));
    await expect(reader.list(query)).resolves.toEqual({ grants: [grant], pendingRequests: [] });

    retireAccountLifetimePluginPermissionGrant(grant.id);
    await expect(reader.list(query)).resolves.toEqual({ grants: [], pendingRequests: [] });

    const replacementGrant = { ...grant, id: 'grant-2' } as const;
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { grants: [replacementGrant], pendingRequests: [] } });
    await expect(reader.list(query)).resolves.toEqual({ grants: [replacementGrant], pendingRequests: [] });
    vi.mocked(axios.post).mockRejectedValue(new Error('relay unavailable'));
    retireAccountLifetimePluginPermissionGrantsForPlugin(grant.pluginId);
    await expect(reader.list(query)).resolves.toEqual({ grants: [], pendingRequests: [] });

    vi.mocked(axios.post).mockResolvedValueOnce({ data: { grants: [replacementGrant], pendingRequests: [] } });
    await expect(reader.list(query)).resolves.toEqual({ grants: [replacementGrant], pendingRequests: [] });
    vi.mocked(axios.post).mockRejectedValue(new Error('relay unavailable'));

    lifetime += 1;
    scopeKey = 'account-scope-2';
    await expect(reader.list(query)).resolves.toEqual({ grants: [], pendingRequests: [] });

    resetAccountLifetimePluginPermissionGrantProjectionForTests();
    await expect(reader.list(query)).resolves.toEqual({ grants: [], pendingRequests: [] });
  });

  it('does not let an older in-flight list response resurrect a locally revoked grant', async () => {
    const subject = PluginPermissionSubjectV1Schema.parse({
      kind: 'credential_access_disclosure',
      contribution: { pluginId: 'acme.voice', localId: 'speech' },
      credentialSlotId: 'api_key',
      purpose: 'voice.speech',
      accessDeclarationDigest: 'c'.repeat(64),
      selectedAuthorityDigest: 'd'.repeat(64),
      selectedRawAccessDigest: 'e'.repeat(64),
    });
    const grant = {
      v: 1, id: 'grant-race', accountId: 'account-1', pluginId: 'acme.voice',
      capability: 'credentials.materialize.raw', targetScope: { kind: 'account' }, subject,
      authoritySource: { kind: 'machine_installation', machineId: 'machine-1', installationId: 'install-1' },
      status: 'active', grantedByUserId: 'user-1', grantedAt: 1, createdAt: 1, updatedAt: 1,
    } as const;
    let release!: () => void;
    vi.mocked(axios.post).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { data: { grants: [grant], pendingRequests: [] } };
    });
    const reader = createAccountLifetimePluginPermissionGrantListReader({
      credentials: { token: 'account-token', encryption: null },
      getScopeKey: () => 'account-scope',
      getLifetimeToken: () => 1,
    });
    const pending = reader.list({
      pluginId: grant.pluginId,
      capability: grant.capability,
      targetScope: grant.targetScope,
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    retireAccountLifetimePluginPermissionGrant(grant.id);
    release();
    await expect(pending).resolves.toEqual({ grants: [], pendingRequests: [] });
  });
});
