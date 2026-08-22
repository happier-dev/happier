import { describe, expect, it, vi } from 'vitest';
import type {
  PluginPermissionGrantRequestV1,
  PluginPermissionGrantV1,
} from '@happier-dev/protocol';

import { createPluginPermissionGrantActionExecutor } from './pluginPermissionGrantActionExecutor';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
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
    authoritySource: { kind: 'bundled' },
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
  it('preflights plugin revoke against the caller-owned grant before mutation', async () => {
    const list = vi.fn(async () => ({
      grants: [grant('grant-own')],
      pendingRequests: [],
    }));
    const mutate = vi.fn(async () => ({ grant: { id: 'grant-own', pluginId: 'acme.voice' } }));
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: {
        list,
        request: vi.fn(),
        mutate,
      },
    });
    const signal = new AbortController().signal;

    await expect(execute({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-own' },
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
      signal,
    })).resolves.toEqual({ grant: { id: 'grant-own', pluginId: 'acme.voice' } });
    expect(list).toHaveBeenCalledWith({
      pluginId: 'acme.voice',
      grantId: 'grant-own',
      includeRevoked: true,
      includeResolvedRequests: false,
      limit: 1,
    }, { signal });
    expect(mutate).toHaveBeenCalledWith(
      'plugins.permissions.grants.revoke',
      { grantId: 'grant-own' },
      { signal },
    );
  });

  it('rejects a foreign or missing grant before the revoke effect', async () => {
    const mutate = vi.fn();
    const execute = createPluginPermissionGrantActionExecutor({
      credentials,
      transport: {
        list: vi.fn(async () => ({
          grants: [grant('grant-other')],
          pendingRequests: [],
        })),
        request: vi.fn(),
        mutate,
      },
    });

    await expect(execute({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-foreign' },
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_permission_grant_not_owned',
      error: 'plugin_permission_grant_not_owned',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('routes list/request and deciding-side mutations through the existing transports', async () => {
    const list = vi.fn(async () => ({ grants: [], pendingRequests: [] }));
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
    await execute({
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
    expect(request).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenNthCalledWith(1, 'plugins.permissions.grants.grant', { requestId: 'request-1' }, {});
    expect(mutate).toHaveBeenNthCalledWith(2, 'plugins.permissions.grants.dismissRequest', { requestId: 'request-1' }, {});
  });
});
