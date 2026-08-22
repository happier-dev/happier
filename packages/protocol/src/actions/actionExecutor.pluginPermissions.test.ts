import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(
  pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>,
) {
  return createActionExecutor({
    pluginPermissionGrantAction,
    isActionApprovalRequired: () => false,
  } as ActionExecutorDeps);
}

describe('createActionExecutor (plugin permission grants)', () => {
  it('binds plugin list/request identity before the canonical permission operation', async () => {
    const pluginPermissionGrantAction = vi.fn(async ({ actionId }) => actionId === 'plugins.permissions.grants.list'
      ? { grants: [], pendingRequests: [] }
      : { pendingRequest: { id: 'request-1' } });
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
    }, context)).resolves.toEqual({ ok: true, result: { pendingRequest: { id: 'request-1' } } });

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
    const pluginPermissionGrantAction = vi.fn(async () => ({ grant: { id: 'grant-1' } }));
    const executor = createExecutor(pluginPermissionGrantAction);
    const context = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
    };

    await expect(executor.execute('plugins.permissions.grants.revoke', {
      grantId: 'grant-1',
      reason: 'No longer needed',
    }, context)).resolves.toEqual({ ok: true, result: { grant: { id: 'grant-1' } } });
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
  });

  it('preserves host-stamped plugin identity through blocking approval replay', async () => {
    const pluginPermissionGrantAction = vi.fn(async () => ({ grant: { id: 'grant-1' } }));
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
    }, { surface: 'ui' })).resolves.toMatchObject({
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
      ? { grant: { id: 'grant-1' }, pendingRequest: { id: 'request-1' } }
      : { pendingRequest: { id: 'request-1' } });
    const executor = createExecutor(pluginPermissionGrantAction);
    const pluginContext = {
      surface: 'plugin' as const,
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.voice' },
    };

    await expect(executor.execute('plugins.permissions.grants.grant', {
      requestId: 'request-1',
    }, pluginContext)).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    await expect(executor.execute('plugins.permissions.grants.dismissRequest', {
      requestId: 'request-1',
    }, pluginContext)).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(pluginPermissionGrantAction).not.toHaveBeenCalled();

    await expect(executor.execute('plugins.permissions.grants.grant', {
      requestId: 'request-1',
    }, { surface: 'ui', actionCaller: { kind: 'host' } })).resolves.toMatchObject({ ok: true });
    await expect(executor.execute('plugins.permissions.grants.dismissRequest', {
      requestId: 'request-1',
    }, { surface: 'ui', actionCaller: { kind: 'host' } })).resolves.toMatchObject({ ok: true });
    expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(2);
  });
});
