import { describe, expect, it, vi } from 'vitest';

const { executeAutomationConversationAction } = vi.hoisted(() => ({
  executeAutomationConversationAction: vi.fn(async () => ({
    kind: 'admitted' as const,
    runId: 'run-1',
    checkpointSafe: true as const,
  })),
}));

vi.mock('@/plugins/runtime/automations/automationConversationActionExecutor', () => ({
  createAutomationConversationActionExecutor: vi.fn(() => executeAutomationConversationAction),
}));

import { createCliActionDeps } from './createCliActionDeps';

type AutomationConversationAction = NonNullable<
  ReturnType<typeof createCliActionDeps>['automationConversationAction']
>;

const request = {
  actionId: 'automation.conversation.admit' as const,
  input: {
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
  },
  caller: {
    kind: 'plugin' as const,
    pluginId: 'happier.channels',
    contributionLocalId: 'provider/observation-ingest-v1',
  },
} satisfies Parameters<AutomationConversationAction>[0];

describe('createCliActionDeps Automation conversation bindings', () => {
  it('routes the canonical Conversation admission Action through the authenticated CLI executor', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.automationConversationAction?.(request)).resolves.toEqual({
      kind: 'admitted',
      runId: 'run-1',
      checkpointSafe: true,
    });
    expect(executeAutomationConversationAction).toHaveBeenCalledWith(request);
  });

  it('fails closed when authenticated credentials are unavailable', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    await expect(deps.automationConversationAction?.(request)).resolves.toEqual({
      ok: false,
      errorCode: 'not_authenticated',
      error: 'not_authenticated',
    });
  });
});
