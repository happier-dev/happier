import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';

const transportMocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: transportMocks.post } }));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

import { createAutomationConversationActionExecutor } from './automationConversationActionExecutor';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

const input = {
  automationId: 'automation-1',
  bindingId: 'binding-1',
  templateVersion: 3,
  occurrenceId: 'telegram:update:1',
  occurredAt: 1_700_000_000_000,
  sender: { id: 'sender-1' },
  text: 'Please summarize the latest change.',
  resultDelivery: {
    kind: 'finalResult',
    actionRef: {
      pluginId: 'happier.channels',
      localId: 'automation/result-deliver-v1',
    },
    opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
  },
} as const;
const callerMaterialization = {
  pluginId: 'happier.channels',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
} as const;

describe('createAutomationConversationActionExecutor', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

  it('signs and sends the bounded target list only to the exact selector endpoint', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: {
        items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
        nextCursor: null,
      },
    });
    const listInput = { limit: 2, cursor: 'automation-0' } as const;
    const executor = createAutomationConversationActionExecutor({ credentials });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: listInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
      nextCursor: null,
    });

    const body = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      input: listInput,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/conversation/targets/list',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/conversation\/targets\/list$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('honors cancellation before the target-list HTTP request', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    controller.abort(cancellation);
    const executor = createAutomationConversationActionExecutor({ credentials });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: {},
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(transportMocks.createPublisherHeader).not.toHaveBeenCalled();
    expect(transportMocks.post).not.toHaveBeenCalled();
  });

  it('signs and sends target verification only to the exact verifier endpoint', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: { kind: 'verified', templateVersion: 3 },
    });
    const verifyInput = {
      automationId: 'automation-1',
      expectedTemplateVersion: 3,
    } as const;
    const executor = createAutomationConversationActionExecutor({
      credentials,
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: verifyInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });

    const body = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      input: verifyInput,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/conversation/target/verify',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/conversation\/target\/verify$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('transports target verification through the strict route with the same stamped caller and cancellation', async () => {
    const controller = new AbortController();
    const verifyInput = {
      automationId: 'automation-1',
      expectedTemplateVersion: 3,
    } as const;
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: verifyInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });
    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      verifyInput,
      {
        caller: {
          pluginId: 'happier.channels',
          contributionLocalId: 'binding/create-v1',
          materialization: callerMaterialization,
        },
        signal: controller.signal,
      },
    );
  });

  it('honors cancellation before the verifier HTTP request', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    controller.abort(cancellation);
    const executor = createAutomationConversationActionExecutor({
      credentials,
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(transportMocks.createPublisherHeader).not.toHaveBeenCalled();
    expect(transportMocks.post).not.toHaveBeenCalled();
  });

  it('forwards the host-stamped ingress materialization and cancellation without accepting target authority in input', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.admit',
      input,
      {
        caller: {
          pluginId: 'happier.channels',
          contributionLocalId: 'provider/observation-ingest-v1',
          materialization: callerMaterialization,
        },
        signal: controller.signal,
      },
    );
  });

  it('forwards a current host-stamped external plugin caller for generic conversation admission', async () => {
    const externalMaterialization = {
      ...callerMaterialization,
      pluginId: 'com.acme.other',
    } as const;
    const execute = vi.fn(async () => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.other',
        contributionLocalId: 'observation-ingest-v1',
        materialization: externalMaterialization,
      },
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute).toHaveBeenCalledWith('automation.conversation.admit', input, {
      caller: {
        pluginId: 'com.acme.other',
        contributionLocalId: 'observation-ingest-v1',
        materialization: externalMaterialization,
      },
    });
  });

  it('fails closed before transport when the host-stamped caller materialization is absent', async () => {
    const execute = vi.fn();
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_materialization_unavailable',
      error: 'automation_conversation_caller_materialization_unavailable',
    });
  });

  it('rejects a caller the host never stamped as a plugin before transport', async () => {
    const execute = vi.fn();
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    // The canonical executor already refuses a non-plugin caller for these
    // plugin-only Actions, so any frame reaching here is missing the exact
    // host-stamped contribution this transport must publish.
    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: { kind: 'host' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_contribution_unavailable',
      error: 'automation_conversation_caller_contribution_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('drives the whole conversation flow for a third-party plugin that is not Channels', async () => {
    const thirdPartyMaterialization = {
      pluginId: 'acme.slack-bridge',
      machineId: 'machine-caller',
      materializationId: 'materialization-slack-1',
    } as const;
    const thirdPartyCaller = {
      kind: 'plugin',
      pluginId: 'acme.slack-bridge',
      contributionLocalId: 'slack/binding-v1',
      materialization: thirdPartyMaterialization,
    } as const;
    const stampedCaller = {
      pluginId: 'acme.slack-bridge',
      contributionLocalId: 'slack/binding-v1',
      materialization: thirdPartyMaterialization,
    } as const;
    const admitInput = {
      ...input,
      // `resultDelivery` stays `none` because the reply-handoff actionRef is
      // still pinned to `happier.channels` by the result-delivery schema.
      // Conversation participation itself is open to any host-stamped plugin.
      resultDelivery: { kind: 'none' },
    } as const;
    const execute = vi.fn(async (
      actionId: string,
      _transportInput: unknown,
      options: Readonly<{ caller: unknown }>,
    ) => {
      expect(options.caller).toEqual(stampedCaller);
      return actionId === 'automation.conversation.targets.list'
        ? { items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Target' }], nextCursor: null }
        : actionId === 'automation.conversation.target.verify'
          ? { kind: 'verified' as const, templateVersion: 3 }
          : { kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const };
    });
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: { limit: 2 },
      caller: thirdPartyCaller,
    })).resolves.toEqual({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Target' }],
      nextCursor: null,
    });
    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: thirdPartyCaller,
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });
    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: admitInput,
      caller: thirdPartyCaller,
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'automation.conversation.targets.list',
      'automation.conversation.target.verify',
      'automation.conversation.admit',
    ]);
  });
});
