import { describe, expect, it } from 'vitest';

import {
  transitionConversationBinding,
  type ConversationBindingStateV1,
} from './bindingTransition.js';

function binding(overrides: Partial<ConversationBindingStateV1> = {}): ConversationBindingStateV1 {
  return {
    connectionId: 'connection-1',
    endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-1', label: 'DM with Ada' },
    target: {
      kind: 'session',
      sessionId: 'session-1',
      policy: {
        deliveryMode: 'repliesOnly',
        permissionCeiling: 'yolo',
        approvals: { kind: 'off' },
        newSession: { kind: 'off' },
      },
    },
    allowedPrincipalIds: ['principal-ada'],
    allowBotSenders: false,
    inputMode: 'directMentionsOnly',
    inboundDebounceMs: 750,
    linkPreviewPolicy: 'suppress',
    senderFeedback: 'off',
    authorityEpoch: 7,
    enabled: true,
    ...overrides,
  };
}

describe('Conversation binding transition', () => {
  it('preserves an Automation final-result policy for the authoritative target verifier', () => {
    const current = binding({
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        templateVersion: 3,
        policy: { resultDelivery: 'finalResult' },
      },
    });

    expect(transitionConversationBinding({
      current,
      requested: current,
    })).toEqual({ kind: 'unchanged', binding: current });
  });

  it('treats a change from direct-only to addressed shared-message input as an authority change', () => {
    const current = binding();

    expect(transitionConversationBinding({
      current,
      requested: { ...current, inputMode: 'addressedMessages' },
    })).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: false,
      binding: {
        inputMode: 'addressedMessages',
        authorityEpoch: 8,
      },
    });
  });

  it('clamps the Session permission policy in the same authority update when an audience expands', () => {
    const current = binding();
    const result = transitionConversationBinding({
      current,
      requested: {
        ...current,
        allowedPrincipalIds: ['principal-ada', 'principal-grace'],
      },
    });

    expect(result).toEqual({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: true,
      binding: {
        ...current,
        allowedPrincipalIds: ['principal-ada', 'principal-grace'],
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: 'repliesOnly',
            permissionCeiling: 'read-only',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        authorityEpoch: 8,
      },
    });
  });

  it('treats enabled approval and new-Session recipe changes as Session target authority changes', () => {
    const current = binding({
      target: {
        kind: 'session',
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'repliesOnly',
          permissionCeiling: 'read-only',
          approvals: {
            kind: 'enabled',
            maximumScope: 'request',
            principalIds: ['principal-ada'],
          },
          newSession: {
            kind: 'enabled',
            principalIds: ['principal-ada'],
            recipe: { agentId: 'agent-1' },
          },
        },
      },
    });
    if (current.target.kind !== 'session') throw new Error('Expected Session target.');

    expect(transitionConversationBinding({
      current,
      requested: {
        ...current,
        target: {
          ...current.target,
          policy: {
            ...current.target.policy,
            approvals: {
              kind: 'enabled',
              maximumScope: 'session',
              principalIds: ['principal-ada'],
            },
            newSession: {
              kind: 'enabled',
              principalIds: ['principal-ada'],
              recipe: { agentId: 'agent-2' },
            },
          },
        },
      },
    })).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: false,
      binding: { authorityEpoch: 8 },
    });
  });

  it('rejects approval and new-Session principal subsets outside the binding allowlist', () => {
    const current = binding();
    if (current.target.kind !== 'session') throw new Error('Expected Session target.');

    const approvalOutsideAllowlist = transitionConversationBinding({
      current,
      requested: {
        ...current,
        target: {
          ...current.target,
          policy: {
            ...current.target.policy,
            approvals: {
              kind: 'enabled',
              maximumScope: 'request',
              principalIds: ['principal-grace'],
            },
          },
        },
      },
    });
    const newSessionOutsideAllowlist = transitionConversationBinding({
      current,
      requested: {
        ...current,
        target: {
          ...current.target,
          policy: {
            ...current.target.policy,
            newSession: {
              kind: 'enabled',
              principalIds: ['principal-grace'],
              recipe: { agentId: 'agent-1' },
            },
          },
        },
      },
    });

    expect(approvalOutsideAllowlist).toEqual({ kind: 'rejected', code: 'policyPrincipalNotAllowed' });
    expect(newSessionOutsideAllowlist).toEqual({ kind: 'rejected', code: 'policyPrincipalNotAllowed' });
  });

  it('does not advance authority or clamp a label refresh and sender-feedback edit', () => {
    const current = binding();
    const result = transitionConversationBinding({
      current,
      requested: {
        ...current,
        endpoint: { ...current.endpoint, label: 'Ada Lovelace' },
        senderFeedback: 'eligibleRefusals',
      },
    });

    expect(result).toEqual({
      kind: 'updated',
      authorityChanged: false,
      policyClamped: false,
      binding: {
        ...current,
        endpoint: { ...current.endpoint, label: 'Ada Lovelace' },
        senderFeedback: 'eligibleRefusals',
      },
    });
  });

  it('preserves an owner-requested broader ceiling for a narrowing edit but clamps an endpoint identity change', () => {
    const current = binding({
      allowedPrincipalIds: ['principal-ada', 'principal-grace'],
      authorityEpoch: 3,
    });
    const narrowing = transitionConversationBinding({
      current,
      requested: {
        ...current,
        allowedPrincipalIds: ['principal-ada'],
      },
    });
    const endpointChange = transitionConversationBinding({
      current,
      requested: {
        ...current,
        endpoint: { ...current.endpoint, id: 'endpoint-2', label: 'DM with Grace' },
      },
    });

    expect(narrowing).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: false,
      binding: {
        authorityEpoch: 4,
        target: { kind: 'session', policy: { permissionCeiling: 'yolo' } },
      },
    });
    expect(endpointChange).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: true,
      binding: {
        authorityEpoch: 4,
        target: { kind: 'session', policy: { permissionCeiling: 'read-only', approvals: { kind: 'off' } } },
      },
    });
  });

  it('fences a private thread that becomes shared even when its provider endpoint ID is unchanged', () => {
    const current = binding({
      authorityEpoch: 3,
      endpoint: { kind: 'thread', audience: 'direct', id: 'thread-1' },
    });

    expect(transitionConversationBinding({
      current,
      requested: {
        ...current,
        // The same provider thread, now shared: spreading the endpoint union
        // instead would offer `direct` kinds a `shared` audience they cannot
        // carry, which is not the transition this case fences.
        endpoint: { kind: 'thread' as const, audience: 'shared' as const, id: current.endpoint.id },
      },
    })).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: true,
      binding: {
        authorityEpoch: 4,
        endpoint: { kind: 'thread', audience: 'shared', id: 'thread-1' },
        target: { kind: 'session', policy: { permissionCeiling: 'read-only' } },
      },
    });
  });

  it('treats an Automation template-version replacement as a target authority change', () => {
    const currentTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      templateVersion: 3,
      policy: { resultDelivery: 'none' },
    } satisfies ConversationBindingStateV1['target'];
    const replacementTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      templateVersion: 4,
      policy: { resultDelivery: 'none' },
    } satisfies ConversationBindingStateV1['target'];
    const current = binding({
      target: currentTarget,
    });

    expect(transitionConversationBinding({
      current,
      requested: {
        ...current,
        target: replacementTarget,
      },
    })).toMatchObject({
      kind: 'updated',
      authorityChanged: true,
      policyClamped: false,
      binding: {
        authorityEpoch: 8,
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 4,
        },
      },
    });
  });
});
