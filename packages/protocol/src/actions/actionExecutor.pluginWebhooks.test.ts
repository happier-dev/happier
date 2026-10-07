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
  setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
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
      authority: 'present_user',
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
    }, { surface: 'ui', authority: 'present_user' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(pluginWebhookAction).not.toHaveBeenCalled();
  });

  /**
   * The one place that answers "may a trusted plugin drive the generic
   * endpoint itself?". Generic endpoint observation and unrestricted retarget
   * are present-user administration, so a daemon-side plugin caller — which
   * the host always stamps `account_automation` — must request consent before any
   * endpoint effect. Unattended plugin execution owns two bounded capabilities:
   * the correspondence check and the correspondence-gated target convergence.
   */
  describe('trusted-plugin caller authority', () => {
    const pluginCaller = {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contributionLocalId: 'management',
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'happier.channels',
      },
    } as const;

    it('fails closed without approval support for plugin-driven endpoint read and retarget', async () => {
      const pluginWebhookAction = vi.fn(async () => ({}));
      const executor = createActionExecutor({
        pluginWebhookAction,
        isActionApprovalRequired: () => false,
      } as ActionExecutorDeps);

      await expect(executor.execute('plugin.webhook.endpoint.read', {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
      }, {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: pluginCaller,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'approvals_not_supported',
        error: 'approvals_not_supported',
      });

      await expect(executor.execute('plugin.webhook.endpoint.retarget', {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        expectedRevision: 4,
        targetMaterialization: {
          machineId: 'machine-2',
          materializationId: 'materialization-2',
          pluginId: 'happier.channels',
        },
        idempotencyKey: 'xfer.connection-1.5.webhook',
      }, {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: pluginCaller,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'approvals_not_supported',
        error: 'approvals_not_supported',
      });

      expect(pluginWebhookAction).not.toHaveBeenCalled();
    });

    it('admits the correspondence check as the plugin-surface endpoint capability', async () => {
      const pluginWebhookAction = vi.fn(async () => ({
        kind: 'ready' as const,
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        revision: 4,
      }));
      const executor = createActionExecutor({
        pluginWebhookAction,
        isActionApprovalRequired: () => false,
      } as ActionExecutorDeps);

      await expect(executor.execute('plugin.webhook.endpoint.checkCorrespondence', {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        webhookContribution: { pluginId: 'happier.channels', localId: 'webhook' },
        targetMaterialization: {
          machineId: 'machine-2',
          materializationId: 'materialization-2',
          pluginId: 'happier.channels',
        },
        sourceInstanceId: 'channels.connection.connection-1',
        setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
      }, {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: pluginCaller,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'ready',
          webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
          revision: 4,
        },
      });

      expect(pluginWebhookAction).toHaveBeenCalledTimes(1);
    });

    it('admits correspondence-gated target convergence and stamps the plugin caller', async () => {
      const controller = new AbortController();
      const pluginWebhookAction = vi.fn(async () => ({
        kind: 'converged' as const,
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        revision: 5,
        targetMaterialization: {
          machineId: 'machine-2',
          materializationId: 'materialization-2',
          pluginId: 'acme.github',
        },
        targetIntentEpoch: 6,
      }));
      const executor = createActionExecutor({
        pluginWebhookAction,
        isActionApprovalRequired: () => false,
      } as ActionExecutorDeps);
      const convergeInput = {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        webhookContribution: { pluginId: 'acme.github', localId: 'events' },
        sourceInstanceId: 'channels.connection.connection-1',
        setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
        desiredTargetMaterialization: {
          machineId: 'machine-2',
          materializationId: 'materialization-2',
          pluginId: 'acme.github',
        },
        targetIntentEpoch: 6,
      } as const;

      await expect(executor.execute('plugin.webhook.endpoint.convergeTarget', convergeInput, {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: pluginCaller,
        signal: controller.signal,
      })).resolves.toEqual({
        ok: true,
        result: {
          kind: 'converged',
          webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
          revision: 5,
          targetMaterialization: {
            machineId: 'machine-2',
            materializationId: 'materialization-2',
            pluginId: 'acme.github',
          },
          targetIntentEpoch: 6,
        },
      });

      expect(pluginWebhookAction).toHaveBeenCalledWith({
        actionId: 'plugin.webhook.endpoint.convergeTarget',
        input: convergeInput,
        caller: pluginCaller,
        signal: controller.signal,
      });
    });

    /**
     * Convergence never accepts an endpoint revision: the endpoint revision is
     * moved by unrelated present-user operations, so admitting one here would
     * reintroduce the conflict this operation exists to remove.
     */
    it('rejects an expected endpoint revision before invoking the canonical owner', async () => {
      const pluginWebhookAction = vi.fn(async () => ({}));
      const executor = createActionExecutor({
        pluginWebhookAction,
        isActionApprovalRequired: () => false,
      } as ActionExecutorDeps);

      await expect(executor.execute('plugin.webhook.endpoint.convergeTarget', {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        webhookContribution: { pluginId: 'acme.github', localId: 'events' },
        sourceInstanceId: 'channels.connection.connection-1',
        setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
        desiredTargetMaterialization: {
          machineId: 'machine-2',
          materializationId: 'materialization-2',
          pluginId: 'acme.github',
        },
        targetIntentEpoch: 6,
        expectedRevision: 4,
      }, {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: pluginCaller,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
      expect(pluginWebhookAction).not.toHaveBeenCalled();
    });
  });
});
