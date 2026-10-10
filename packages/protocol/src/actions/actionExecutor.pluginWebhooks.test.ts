import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

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
  it.each(['agent', 'mcp'] as const)('requires human setup consent on %s and confines the secret to the deciding human', async (surface) => {
    expect(getActionSpec('plugin.webhook.endpoint.ensure').safety).toBe('danger');
    let stored: ApprovalRequest | null = null;
    const persisted: ApprovalRequest[] = [];
    const metadata = {
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 1,
      publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
      readiness: 'providerConfirmationRequired' as const,
    };
    const secret = 'one-time-webhook-credential';
    // HTTP endpoint and Artifact persistence are system boundaries; admission,
    // approval transitions, replay and observation projection remain real.
    const pluginWebhookAction = vi.fn(async () => ({ ...metadata, oneTimeGeneratedSecret: secret }));
    const observeActionExecution = vi.fn();
    const executor = createActionExecutor({
      pluginWebhookAction, observeActionExecution,
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => {
        stored = request; persisted.push(request); return { artifactId: 'webhook-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = request; persisted.push(request); return { ok: true as const };
      },
    } as ActionExecutorDeps);
    const requested = await executor.execute('plugin.webhook.endpoint.ensure', ensureInput, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'webhook-ensure-1',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'plugin.webhook.endpoint.ensure': [surface],
      } }),
    });
    expect(requested).toMatchObject({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'webhook-approval',
    } });
    expect(pluginWebhookAction).not.toHaveBeenCalled();
    expect(await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface, authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1' });
    expect(decided).toMatchObject({ ok: true, result: {
      status: 'executed', execution: { ok: true, result: metadata },
      liveExecution: { ok: true, result: { ...metadata, oneTimeGeneratedSecret: secret } },
    } });
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(secret);
    const repeated = await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-1' });
    expect(JSON.stringify(repeated)).not.toContain(secret);
    expect(pluginWebhookAction).toHaveBeenCalledOnce();
  });

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
   * are present-user administration: plugin requests enter approval custody
   * before any endpoint effect. The plugin surface directly owns two bounded capabilities:
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


    it('requests approval for plugin-driven endpoint read and retarget before any endpoint effect', async () => {
      const pluginWebhookAction = vi.fn(async () => ({}));
      const executor = createActionExecutor({
        pluginWebhookAction,
        approvalsCreate: async () => ({ artifactId: 'endpoint-approval' }),
        isActionApprovalRequired: () => false,
      } as ActionExecutorDeps);

      await expect(executor.execute('plugin.webhook.endpoint.read', {
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
      }, {
        surface: 'plugin',
        serverId: 'server-1',
        actionRequestId: 'endpoint-read-1',
        authority: 'account_automation',
        actionCaller: {
          ...pluginCaller,
          sourceCustody: { kind: 'development', registeredRootId: 'channels-root-1' },
        },
      })).resolves.toEqual({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'endpoint-approval', actionId: 'plugin.webhook.endpoint.read' },
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
        serverId: 'server-1',
        actionRequestId: 'endpoint-retarget-1',
        authority: 'account_automation',
        actionCaller: {
          ...pluginCaller,
          sourceCustody: { kind: 'development', registeredRootId: 'channels-root-1' },
        },
      })).resolves.toEqual({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'endpoint-approval', actionId: 'plugin.webhook.endpoint.retarget' },
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
