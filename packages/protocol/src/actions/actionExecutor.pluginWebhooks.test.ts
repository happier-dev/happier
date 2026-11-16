import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
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
  it.each([
    { surface: 'cli', miswired: false },
    { surface: 'ui', miswired: false },
    { surface: 'cli', miswired: true },
  ] as const)('settles explicit $surface movePending after invocation ends (miswired=$miswired)', async ({ surface, miswired }) => {
    const actionId = 'plugin.webhook.delivery.movePending';
    const input = { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', endpointRevision: 3,
      targetMaterialization: ensureInput.targetMaterialization, pageSize: 500 };
    const result = { moved: 2, skippedClaimed: 0, nextCursor: null, done: true };
    let stored: ApprovalRequest | null = null;
    const effects: unknown[] = [];
    // HTTP execution and Artifact persistence are genuine boundaries; admission/replay are real.
    const deps = {
      pluginWebhookAction: async args => { effects.push(args); return result; },
      readActionsSettings: (context) => (context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 })),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'move-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true as const }; },
    } satisfies ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const requested = await executor.execute('approval.request.create', {
      actionId, actionArgs: input, summary: 'Move pending deliveries', createdBy: { surface: 'system' },
    }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'move-request',
    });
    expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true, result: { artifactId: 'move-approval' } });
    expect(stored).toMatchObject({ approval: { flow: 'deferred', result: 'required' } });
    expect(effects).toEqual([]);
    // A different executor consumes the real producer's strict stored request;
    // no originating invocation or plugin source lifetime can be restored here.
    const decidingExecutor = createActionExecutor(deps);
    if (miswired) {
      // Mis-bind durable custody to a blocking continuation. The consumer must
      // refuse rather than relaxing the live-invocation consent guard.
      const request = ApprovalRequestV2Schema.parse(stored);
      stored = ApprovalRequestV2Schema.parse({ ...request, approval: { ...request.approval, flow: 'blocking' } });
      expect(await decidingExecutor.execute('approval.request.decide', { artifactId: 'move-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
      })).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable', effectAttempted: false,
        details: { reason: 'live_invocation_unavailable' },
      });
      expect(stored).toMatchObject({ status: 'approved' });
      expect(effects).toEqual([]);
      return;
    }
    expect(await decidingExecutor.execute('approval.request.decide', { artifactId: 'move-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
    })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result } } });
    expect(effects).toEqual([expect.objectContaining({ actionId, input, caller: { kind: 'host' } })]);
  });
  it('keeps delivery replay, discard and move Ask-first with a user-changeable surface default', async () => {
    for (const actionId of ['plugin.webhook.delivery.replay', 'plugin.webhook.delivery.discard', 'plugin.webhook.delivery.movePending'] as const) {
      const input = actionId === 'plugin.webhook.delivery.movePending'
        ? { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', endpointRevision: 3,
            targetMaterialization: ensureInput.targetMaterialization, pageSize: 500 }
        : { deliveryId: 'delivery-1', expectedRevision: 3 };
      const result = actionId === 'plugin.webhook.delivery.movePending'
        ? { moved: 2, skippedClaimed: 0, nextCursor: null, done: true }
        : { kind: actionId.endsWith('replay') ? 'requeued' : 'discarded', revision: 4 };
      const effects: unknown[] = [];
      const executor = createActionExecutor({
        pluginWebhookAction: async args => { effects.push(args); return result; },
        readActionsSettings: (context) => (context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 })),
      } as ActionExecutorDeps);
      for (const surface of ['agent', 'mcp'] as const) {
        const context = { surface, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(effects).toEqual([]);
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(await executor.execute(actionId, input, { ...context, actionsSettings })).toEqual({ ok: true, result });
        expect(effects.pop()).toMatchObject({ actionId, input, caller: { kind: 'host' } });
      }
    }
  });
  it.each((['agent', 'mcp'] as const).flatMap(surface =>
    (['signed', 'capability', 'read'] as const).map(mode => ({ surface, mode })),
  ))('requires human setup consent on $surface for $mode and retains metadata without live secrets', async ({ surface, mode }) => {
    const actionId = mode === 'read' ? 'plugin.webhook.endpoint.read' : 'plugin.webhook.endpoint.ensure';
    const actionInput = mode === 'read' ? { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' }
      : mode === 'capability' ? { ...ensureInput, setup: { kind: 'capabilityUrlV1', checkId: 'monitor' } } : ensureInput;
    expect(getActionSpec('plugin.webhook.endpoint.ensure').safety).toBe('danger');
    let stored: ApprovalRequest | null = null;
    const persisted: ApprovalRequest[] = [];
    const metadata = {
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', revision: 1,
      readiness: 'providerConfirmationRequired' as const,
      ...(mode === 'read' ? { contribution: ensureInput.webhookContribution,
        targetMaterialization: ensureInput.targetMaterialization, sourceInstanceId: ensureInput.sourceInstanceId,
        routing: 'accountEndpoint' as const, createdAt: 1000 } : {}),
    };
    const publicUrl = 'https://example.test/v1/plugins/webhooks/private-capability-url';
    const secret = 'one-time-webhook-credential';
    const liveOutput = { ...metadata, publicUrl, ...(mode === 'signed' ? { oneTimeGeneratedSecret: secret } : {}) };
    // HTTP endpoint and Artifact persistence are system boundaries; admission,
    // approval transitions, replay and observation projection remain real.
    const pluginWebhookAction = vi.fn(async () => liveOutput);
    const observeActionExecution = vi.fn();
    const executor = createActionExecutor({
      pluginWebhookAction, observeActionExecution,
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => {
        stored = structuredClone(request); persisted.push(structuredClone(request)); return { artifactId: 'webhook-approval' };
      },
      approvalsGet: async () => stored === null ? null : structuredClone(stored),
      approvalsUpdate: async ({ request }) => {
        stored = structuredClone(request); persisted.push(structuredClone(request)); return { ok: true as const };
      },
    } as ActionExecutorDeps);
    const requester = {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'webhook-ensure-1',
    } as const;
    const waived = await executor.execute(actionId, actionInput, { ...requester, actionRequestId: 'webhook-waived-1',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        [actionId]: [surface],
      } }),
    });
    expect(waived).not.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(waived).toEqual({ ok: true, result: liveOutput });
    expect(stored).toBeNull();
    pluginWebhookAction.mockClear();
    // Explicit CLI requests use the canonical detached flow for live-only
    // results; Agent/MCP direct Ask retains a blocking invocation instead.
    const requested = await executor.execute('approval.request.create', {
      actionId, actionArgs: actionInput, summary: 'Manage webhook endpoint', createdBy: { surface: 'system' },
    }, { ...requester, surface: 'cli', authority: 'present_user', actionRequestId: 'webhook-human-request' });
    expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true, result: {
      artifactId: 'webhook-approval',
    } });
    expect(pluginWebhookAction).not.toHaveBeenCalled();
    expect(await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface, authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1' });
    expect(JSON.stringify(persisted)).not.toContain(publicUrl);
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(publicUrl);
    expect(decided).toMatchObject({ ok: true, result: {
      status: 'executed', execution: { ok: true, result: metadata },
      liveExecution: { ok: true, result: liveOutput },
    } });
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(secret);
    const repeated = await executor.execute('approval.request.decide', {
      artifactId: 'webhook-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-1' });
    expect(JSON.stringify(repeated)).not.toContain(secret);
    expect(JSON.stringify(repeated)).not.toContain(publicUrl);
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

    } as ActionExecutorDeps);

    await expect(executor.execute('plugin.webhook.endpoint.ensure', {
      ...ensureInput,
      serverId: 'caller-controlled-server',
    }, { surface: 'ui', authority: 'present_user' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { issues: [{ code: 'unrecognized_keys', path: [], message: expect.any(String) }] },
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


    it('retains blocking read and deferred retarget approval before any plugin endpoint effect', async () => {
      const pluginWebhookAction = vi.fn(async () => ({}));
      const created: ApprovalRequest[] = [];
      const executor = createActionExecutor({
        pluginWebhookAction,
        approvalsCreate: async ({ request }) => { created.push(request); return { artifactId: 'endpoint-approval' }; },
        approvalsGet: async () => created.at(-1) ?? null,
        approvalsUpdate: async () => ({ ok: true }),
        approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
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
        ok: false, errorCode: 'approval_rejected', error: 'approval_rejected',
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

      expect(created).toMatchObject([
        { actionId: 'plugin.webhook.endpoint.read', approval: { flow: 'blocking' } },
        { actionId: 'plugin.webhook.endpoint.retarget', approval: { flow: 'deferred' } },
      ]);
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
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'plugin.webhook.endpoint.convergeTarget': ['plugin'] } }),
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
        details: { issues: [{ code: 'unrecognized_keys', path: [], message: expect.any(String) }] },
      });
      expect(pluginWebhookAction).not.toHaveBeenCalled();
    });
  });
});
