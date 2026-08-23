import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import type {
  PluginPermissionGrantRequestV1,
  PluginPermissionGrantV1,
} from '../plugins/permissions/grants.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(
  pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>,
) {
  return createActionExecutor({
    pluginPermissionGrantAction,
    isActionApprovalRequired: () => false,
  } as ActionExecutorDeps);
}

const pendingRequest = {
  v: 1,
  id: 'request-1',
  accountId: 'account-1',
  pluginId: 'acme.voice',
  capability: 'credentials.materialize.raw',
  targetScope: { kind: 'account' },
  subject: { kind: 'general' },
  authoritySource: { kind: 'bundled' },
  requester: { kind: 'plugin', pluginId: 'acme.voice', sessionId: 'session-1' },
  reason: 'Reach the declared service',
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
} as const satisfies PluginPermissionGrantRequestV1;

const activeGrant = {
  v: 1,
  id: 'grant-1',
  accountId: 'account-1',
  pluginId: 'acme.voice',
  capability: 'credentials.materialize.raw',
  targetScope: { kind: 'account' },
  subject: { kind: 'general' },
  authoritySource: { kind: 'bundled' },
  status: 'active',
  requestId: 'request-1',
  grantedByUserId: 'user-1',
  grantedAt: 2,
  createdAt: 1,
  updatedAt: 2,
} as const satisfies PluginPermissionGrantV1;

const revokedGrant = {
  ...activeGrant,
  status: 'revoked',
  revokedByUserId: 'user-1',
  revokedAt: 3,
  updatedAt: 3,
} as const satisfies PluginPermissionGrantV1;

const grantedPendingRequest = {
  ...pendingRequest,
  status: 'granted',
  grantId: activeGrant.id,
  decidedByUserId: 'user-1',
  decidedAt: 2,
  updatedAt: 2,
} as const satisfies PluginPermissionGrantRequestV1;

const dismissedPendingRequest = {
  ...pendingRequest,
  status: 'dismissed',
  decidedByUserId: 'user-1',
  decidedAt: 2,
  updatedAt: 2,
} as const satisfies PluginPermissionGrantRequestV1;

describe('createActionExecutor (plugin permission grants)', () => {
  it('binds plugin list/request identity before the canonical permission operation', async () => {
    const pluginPermissionGrantAction = vi.fn(async ({ actionId }) => actionId === 'plugins.permissions.grants.list'
      ? { grants: [], pendingRequests: [] }
      : { pendingRequest });
    const executor = createExecutor(pluginPermissionGrantAction);
    const context = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
      defaultSessionId: 'session-1',
    };

    await expect(executor.execute('plugins.permissions.grants.list', {}, context))
      .resolves.toEqual({ ok: true, result: { grants: [], pendingRequests: [] } });
    await expect(executor.execute('plugins.permissions.grants.request', {
      // `network` used to be a member of PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1, but that list
      // now carries only the capabilities a grant reader actually resolves. Manifest-declared host
      // access (`network`, `filesystem`, `process`, `environment`, ...) is a separate vocabulary
      // owned by PluginHostAccessRequestV2, not by the user-approved grant enum.
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: { kind: 'general' },
      reason: 'Reach the declared service',
    }, context)).resolves.toEqual({ ok: true, result: { pendingRequest } });

    expect(pluginPermissionGrantAction).toHaveBeenNthCalledWith(1, {
      actionId: 'plugins.permissions.grants.list',
      input: expect.objectContaining({ pluginId: 'acme.voice' }),
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    });
    expect(pluginPermissionGrantAction).toHaveBeenNthCalledWith(2, {
      actionId: 'plugins.permissions.grants.request',
      input: expect.objectContaining({
        pluginId: 'acme.voice',
        requester: { kind: 'plugin', pluginId: 'acme.voice', sessionId: 'session-1' },
      }),
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    });
  });

  it('routes own-grant revoke with host-stamped caller and rejects spoofed plugin identity', async () => {
    const pluginPermissionGrantAction = vi.fn(async ({ actionId }) => actionId === 'plugins.permissions.grants.revoke'
      ? { grant: revokedGrant }
      : { pendingRequest });
    const executor = createExecutor(pluginPermissionGrantAction);
    const context = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
    };

    await expect(executor.execute('plugins.permissions.grants.revoke', {
      grantId: 'grant-1',
      reason: 'No longer needed',
    }, context)).resolves.toMatchObject({ ok: true, result: { grant: { id: 'grant-1' } } });
    expect(pluginPermissionGrantAction).toHaveBeenCalledWith({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-1', reason: 'No longer needed' },
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    });

    const spoofableRequest = {
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' as const },
      subject: { kind: 'general' as const },
      reason: 'Spoof identity',
    };
    await expect(executor.execute('plugins.permissions.grants.request', {
      ...spoofableRequest,
      pluginId: 'spoofed.plugin',
    }, context)).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(1);

    // Positive control: the identical request without the caller-supplied `pluginId` is accepted, so
    // the rejection above is attributable to the spoofed identity field alone rather than to any
    // other invalid member of the payload. The host then stamps its own caller identity.
    await expect(executor.execute('plugins.permissions.grants.request', spoofableRequest, context))
      .resolves.toMatchObject({ ok: true });
    expect(pluginPermissionGrantAction).toHaveBeenNthCalledWith(2, {
      actionId: 'plugins.permissions.grants.request',
      input: expect.objectContaining({
        pluginId: 'acme.voice',
        requester: { kind: 'plugin', pluginId: 'acme.voice' },
      }),
      caller: { kind: 'plugin', pluginId: 'acme.voice' },
    });

    await expect(executor.execute('plugins.permissions.grants.revoke', {
      grantId: 'grant-1',
    }, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      details: { reason: 'unsupported_surface', surface: 'api' },
    });
    expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(2);
  });

  it('preserves host-stamped plugin identity through blocking approval replay', async () => {
    const pluginPermissionGrantAction = vi.fn(async () => ({ grant: revokedGrant }));
    let storedRequest: ApprovalRequestV1 | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { artifactId: 'approval-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      pluginPermissionGrantAction,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'plugins.permissions.grants.revoke' && context.surface === 'plugin'
      ),
    } as ActionExecutorDeps);

    await expect(executor.execute('plugins.permissions.grants.revoke', {
      grantId: 'grant-1',
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'acme.voice', contributionLocalId: 'permission-grants' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          pluginId: 'acme.voice',
          contributionLocalId: 'permission-grants',
        }),
      }),
    }));
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });
    expect(pluginPermissionGrantAction).toHaveBeenCalledWith({
      actionId: 'plugins.permissions.grants.revoke',
      input: { grantId: 'grant-1' },
      caller: { kind: 'plugin', pluginId: 'acme.voice', contributionLocalId: 'permission-grants' },
    });
  });

  it('keeps grant/dismiss on the deciding side while routing their host UI execution', async () => {
    const pluginPermissionGrantAction = vi.fn(async ({ actionId }) => actionId === 'plugins.permissions.grants.grant'
      ? { grant: activeGrant, pendingRequest: grantedPendingRequest }
      : { pendingRequest: dismissedPendingRequest });
    const executor = createExecutor(pluginPermissionGrantAction);
    const pluginContext = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
    };

    await expect(executor.execute('plugins.permissions.grants.grant', {
      requestId: 'request-1',
    }, pluginContext)).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    await expect(executor.execute('plugins.permissions.grants.dismissRequest', {
      requestId: 'request-1',
    }, pluginContext)).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(pluginPermissionGrantAction).not.toHaveBeenCalled();

    await expect(executor.execute('plugins.permissions.grants.grant', {
      requestId: 'request-1',
    }, {
      surface: 'ui',
      actionCaller: { kind: 'host' },
      authority: 'present_user',
    })).resolves.toMatchObject({ ok: true });
    await expect(executor.execute('plugins.permissions.grants.dismissRequest', {
      requestId: 'request-1',
    }, {
      surface: 'ui',
      actionCaller: { kind: 'host' },
      authority: 'present_user',
    })).resolves.toMatchObject({ ok: true });
    expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(2);
  });
});
