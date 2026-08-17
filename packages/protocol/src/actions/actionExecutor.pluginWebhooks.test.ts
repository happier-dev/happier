import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const ensureInput = {
  webhookContribution: { pluginId: 'example.github', localId: 'events' },
  targetMaterialization: {
    machineId: 'machine-1',
    materializationId: 'materialization-1',
    pluginId: 'example.github',
  },
  sourceInstanceId: 'channel:github:primary',
  setup: { kind: 'githubAccountEndpointV1', credential: 'serverGenerated' },
  idempotencyKey: 'ensure-github-primary-0001',
} as const;

describe('createActionExecutor (plugin webhook endpoints)', () => {
  it('routes validated endpoint operations to the canonical owner with host-stamped caller and cancellation', async () => {
    const controller = new AbortController();
    const pluginWebhookAction = vi.fn(async () => ({
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
      revision: 1,
      publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
      readiness: 'ready' as const,
    }));
    const executor = createActionExecutor({
      pluginWebhookAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('plugin.webhook.endpoint.ensure', ensureInput, {
      surface: 'ui',
      actionCaller: { kind: 'host' },
      signal: controller.signal,
    })).resolves.toEqual({
      ok: true,
      result: {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        revision: 1,
        publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
        readiness: 'ready',
      },
    });

    expect(pluginWebhookAction).toHaveBeenCalledWith({
      actionId: 'plugin.webhook.endpoint.ensure',
      input: ensureInput,
      caller: { kind: 'host' },
      signal: controller.signal,
    });
  });

  it('rejects malformed endpoint input before invoking the canonical owner', async () => {
    const pluginWebhookAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      pluginWebhookAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('plugin.webhook.endpoint.ensure', {
      ...ensureInput,
      serverId: 'caller-controlled-server',
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(pluginWebhookAction).not.toHaveBeenCalled();
  });
});
