import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  type PluginPermissionGrantRequestV1,
  type PluginPermissionGrantV1,
} from '@happier-dev/protocol';

import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';

import { createPluginPermissionGrantActionExecutor } from './pluginPermissionGrantActionExecutor';

vi.mock('axios');
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: vi.fn(),
}));

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

const callerMaterialization = {
  machineId: 'machine-1',
  materializationId: 'install-epoch-1',
  pluginId: 'acme.voice',
};

function grant(id: string, pluginId = 'acme.voice'): PluginPermissionGrantV1 {
  return {
    v: 1,
    id,
    accountId: 'account-1',
    pluginId,
    capability: 'reviews.comments.write.direct',
    targetScope: { kind: 'account' },
    subject: { kind: 'general' },
    authoritySource: {
      kind: 'machine_installation',
      machineId: callerMaterialization.machineId,
      installationId: callerMaterialization.materializationId,
    },
    status: 'active',
    grantedByUserId: 'user-1',
    grantedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function pendingRequest(id: string, pluginId = 'acme.voice'): PluginPermissionGrantRequestV1 {
  return {
    v: 1,
    id,
    accountId: 'account-1',
    pluginId,
    capability: 'reviews.comments.write.direct',
    targetScope: { kind: 'account' },
    subject: { kind: 'general' },
    authoritySource: { kind: 'bundled' },
    requester: { kind: 'plugin', pluginId },
    reason: 'Reach the declared service',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('createPluginPermissionGrantActionExecutor', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockReset();
  });

  it('signs the exact stamped caller body for plugin list and self-revocation transport', async () => {
    vi.mocked(createDefaultPluginInstallationPublisherHeader)
      .mockResolvedValueOnce('list-publisher-proof')
      .mockResolvedValueOnce('revoke-publisher-proof');
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { grants: [], pendingRequests: [] } })
      .mockResolvedValueOnce({ data: { grant: grant('grant-own') } });
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      revalidateCallerMaterialization: vi.fn(async () => true),
    });
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'acme.voice',
      materialization: callerMaterialization,
    };

    await execute({
      actionId: 'plugins.permissions.grants.list',
      input: {
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 50,
      },
      caller,
    });
    await execute({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-own' },
      caller,
    });

    const listBody = {
      caller: callerMaterialization,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 50,
    };
    const revokeBody = { grantId: 'grant-own', caller: callerMaterialization };
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      path: '/v1/plugins/permissions/grants/list',
      body: listBody,
    });
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      path: '/v1/plugins/permissions/grants/revoke',
      body: revokeBody,
    });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/list$/u),
      listBody,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'list-publisher-proof',
        }),
      }),
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/v1\/plugins\/permissions\/grants\/revoke$/u),
      revokeBody,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'revoke-publisher-proof',
        }),
      }),
    );
  });

  it('sends plugin self-revocation with the exact proven caller and defers ownership to the server', async () => {
    const list = vi.fn();
    const mutate = vi.fn(async () => ({ grant: { id: 'grant-own', pluginId: 'acme.voice' } }));
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: {
        list,
        request: vi.fn(),
        mutate,
      },
      revalidateCallerMaterialization,
    });
    const signal = new AbortController().signal;

    await expect(execute({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-own' },
      caller: {
        kind: 'plugin',
        pluginId: 'acme.voice',
        materialization: callerMaterialization,
      },
      signal,
    })).resolves.toEqual({ grant: { id: 'grant-own', pluginId: 'acme.voice' } });
    expect(revalidateCallerMaterialization).toHaveBeenCalledWith(callerMaterialization);
    expect(list).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith(
      'plugins.permissions.grants.revoke',
      { grantId: 'grant-own', caller: callerMaterialization },
      { signal },
    );
  });

  it('fails closed for a plugin caller without a current host-stamped materialization', async () => {
    const mutate = vi.fn();
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: {
        list: vi.fn(),
        request: vi.fn(),
        mutate,
      },
      revalidateCallerMaterialization: vi.fn(async () => false),
    });

    await expect(execute({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-1' },
      caller: {
        kind: 'plugin',
        pluginId: 'acme.voice',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_permission_grant_caller_materialization_unavailable',
      error: 'plugin_permission_grant_caller_materialization_unavailable',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a plugin caller whose stamped materialization names another plugin', async () => {
    const mutate = vi.fn();
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: {
        list: vi.fn(),
        request: vi.fn(),
        mutate,
      },
      revalidateCallerMaterialization: vi.fn(async () => true),
    });

    await expect(execute({
      actionId: 'plugins.permissions.grants.request',
      input: {
        pluginId: 'acme.voice',
        capability: 'reviews.comments.write.direct',
        targetScope: { kind: 'account' },
        subject: { kind: 'general' },
        requester: { kind: 'plugin', pluginId: 'acme.voice' },
        reason: 'Reach the declared service',
      },
      caller: {
        kind: 'plugin',
        pluginId: 'acme.voice',
        materialization: { ...callerMaterialization, pluginId: 'acme.other' },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_permission_grant_caller_materialization_unavailable',
      error: 'plugin_permission_grant_caller_materialization_unavailable',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps human decision operations callable while rejecting plugin requests without provenance', async () => {
    const list = vi.fn(async () => ({ grants: [grant('grant-1')], pendingRequests: [] }));
    const request = vi.fn(async () => ({ pendingRequest: pendingRequest('request-1') }));
    const mutate = vi.fn(async (actionId: string) => ({ actionId }));
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: { list, request, mutate },
    });
    const host = { kind: 'host' as const };

    await execute({
      actionId: 'plugins.permissions.grants.list',
      input: { pluginId: 'acme.voice', includeRevoked: false, includeResolvedRequests: false, limit: 50 },
      caller: host,
    });
    await expect(execute({
      actionId: 'plugins.permissions.grants.request',
      input: {
        pluginId: 'acme.voice',
        capability: 'reviews.comments.write.direct',
        targetScope: { kind: 'account' },
        subject: { kind: 'general' },
        requester: { kind: 'plugin', pluginId: 'acme.voice' },
        reason: 'Publish approved review comments directly',
      },
      caller: host,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_permission_grant_publisher_proof_required',
      error: 'plugin_permission_grant_publisher_proof_required',
    });
    await execute({
      actionId: 'plugins.permissions.grants.grant',
      input: { requestId: 'request-1' },
      caller: host,
    });
    await execute({
      actionId: 'plugins.permissions.grants.dismissRequest',
      input: { requestId: 'request-1' },
      caller: host,
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenNthCalledWith(1, 'plugins.permissions.grants.grant', { requestId: 'request-1' }, {});
    expect(mutate).toHaveBeenNthCalledWith(2, 'plugins.permissions.grants.dismissRequest', { requestId: 'request-1' }, {});
  });
});
