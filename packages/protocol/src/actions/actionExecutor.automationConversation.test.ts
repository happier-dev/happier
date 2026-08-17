import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const conversationAdmitInput = {
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
  machineId: 'machine-1',
  materializationId: 'materialization-1',
} as const;

describe('createActionExecutor (Automation conversation admission)', () => {
  it('routes the strict input with host-stamped plugin provenance and cancellation', async () => {
    const controller = new AbortController();
    const automationConversationAction = vi.fn(async () => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.conversation.admit', conversationAdmitInput, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
    });

    expect(automationConversationAction).toHaveBeenCalledWith({
      actionId: 'automation.conversation.admit',
      input: conversationAdmitInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    });
  });

  it('routes target verification through the same exact host-stamped caller and cancellation boundary', async () => {
    const controller = new AbortController();
    const input = { automationId: 'automation-1', expectedTemplateVersion: 3 } as const;
    const automationConversationAction = vi.fn(async () => ({
      kind: 'verified' as const,
      templateVersion: 3,
    }));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.conversation.target.verify', input, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { kind: 'verified', templateVersion: 3 } });
    expect(automationConversationAction).toHaveBeenCalledWith({
      actionId: 'automation.conversation.target.verify',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    });
  });

  it('routes the bounded target selector through the same host-stamped caller boundary', async () => {
    const input = { limit: 2, cursor: 'automation-0' } as const;
    const automationConversationAction = vi.fn(async () => ({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
      nextCursor: null,
    }));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.conversation.targets.list', input, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
        nextCursor: null,
      },
    });
    expect(automationConversationAction).toHaveBeenCalledWith({
      actionId: 'automation.conversation.targets.list',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    });
  });

  it('rejects mutable authority and a non-plugin caller before the Automation owner', async () => {
    const automationConversationAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.conversation.admit', {
      ...conversationAdmitInput,
      caller: { pluginId: 'happier.channels' },
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels', materialization: callerMaterialization },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });

    await expect(executor.execute('automation.conversation.admit', conversationAdmitInput, {
      surface: 'plugin',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(automationConversationAction).not.toHaveBeenCalled();
  });

  it('requires the host-stamped originating contribution before the Automation owner', async () => {
    const automationConversationAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.conversation.admit', conversationAdmitInput, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'happier.channels' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(automationConversationAction).not.toHaveBeenCalled();
  });

  it('rejects a non-Channels or materialization-less verifier caller before the Automation owner', async () => {
    const automationConversationAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      automationConversationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);
    const input = { automationId: 'automation-1', expectedTemplateVersion: 3 } as const;

    for (const actionCaller of [
      {
        kind: 'plugin' as const,
        pluginId: 'com.acme.other',
        contributionLocalId: 'binding/create-v1',
        materialization: { ...callerMaterialization, pluginId: 'com.acme.other' },
      },
      {
        kind: 'plugin' as const,
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
      },
    ]) {
      await expect(executor.execute('automation.conversation.target.verify', input, {
        surface: 'plugin',
        actionCaller,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'plugin_action_caller_required',
        error: 'plugin_action_caller_required',
      });
    }
    expect(automationConversationAction).not.toHaveBeenCalled();
  });
});
