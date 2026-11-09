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
  it.each([
    { inboundDebounceMs: 1_500 },
    { linkPreviewPolicy: 'providerDefault' as const },
    { senderFeedback: 'off' as const, endpoint: { kind: 'direct' as const, audience: 'direct' as const, id: 'endpoint-1', label: 'Renamed' } },
  ])('preserves input authority for presentation and batching edits: %j', patch => {
    const current = binding();
    expect(transitionConversationBinding({ current, requested: { ...current, ...patch } }))
      .toMatchObject({ kind: 'updated',  binding: { authorityEpoch: 7 } });
  });
  it('rejects host attestation in every authored Session recipe, including unchanged retained targets', () => {
    const base = binding();
    if (base.target.kind !== 'session') throw new Error('Expected Session target');
    const policy = base.target.policy;
    const forgedRecipe = { attestedContext: { externalPrincipalId: 'forged', sourceMessageId: '<forged>' } };
    const targets = [
      { ...base.target, policy: { ...policy, newSession: { kind: 'enabled', recipe: forgedRecipe } } },
      { kind: 'threadRouter', principalGroups: [{ id: 'sales', principalIds: ['principal-ada'] }],
        routes: [{ id: 'intake', when: { group: 'sales', forwarded: 'any' }, recipe: forgedRecipe, policy }] },
      { kind: 'threadRouter', principalGroups: [{ id: 'sales', principalIds: ['principal-ada'] }],
        routes: [{ id: 'intake', when: { group: 'sales', forwarded: 'any' }, recipe: {},
          policy: { ...policy, newSession: { kind: 'enabled', recipe: forgedRecipe } } }] },
    ] as const;
    for (const target of targets) {
      const current = binding({ target });
      expect(transitionConversationBinding({ current, requested: current })).toEqual({ kind: 'rejected', code: 'recipeAttestationForbidden' });
    }
  });
  it('derives router authority from groups, preserves child parentage, and rejects missing route groups', () => {
    const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } as const;
    const router = { kind: 'threadRouter', principalGroups: [{ id: 'sales', principalIds: ['principal-ada', 'principal-grace'] }], routes: [{ id: 'intake', when: { group: 'sales', forwarded: 'any' }, recipe: {}, policy }] } as const;
    const current = binding();
    expect(transitionConversationBinding({ current, requested: { ...current, target: router } })).toMatchObject({ kind: 'updated', binding: { allowedPrincipalIds: ['principal-ada', 'principal-grace'] } });
    expect(transitionConversationBinding({ current, requested: { ...current, target: { ...router, routes: [{ ...router.routes[0], when: { group: 'missing', forwarded: 'any' } }] } } })).toEqual({ kind: 'rejected', code: 'routerGroupNotFound' });
    const child = binding({ parentBindingId: 'binding-router' });
    expect(transitionConversationBinding({ current: child, requested: { ...child, enabled: false } })).toMatchObject({ binding: { parentBindingId: 'binding-router' } });
  });
  it('refuses changing a scoped trigger to a different authenticated PR endpoint', () => {
    const current = binding({ endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'pr-5', pullRequest: { repository: 'acme/widgets', number: 5 } }, target: {
      kind: 'automation', automationId: 'automation-1', policy: { resultDelivery: 'none' },
      scopedTrigger: { sessionId: 'session-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind: 'prComment', principalPolicy: 'repositoryWriters', pullRequest: { repository: 'acme/widgets', number: 5 } },
    } });
    expect(transitionConversationBinding({ current, requested: { ...current, endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'pr-6', pullRequest: { repository: 'acme/widgets', number: 6 } } } })).toEqual({ kind: 'rejected', code: 'pullRequestCorrespondenceMismatch' });
  });
  it('preserves an Automation final-result policy for the authoritative target verifier', () => {
    const current = binding({
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        policy: { resultDelivery: 'finalResult' },
      },
    });

    expect(transitionConversationBinding({
      current,
      requested: current,
    })).toEqual({ kind: 'unchanged', binding: current });
  });

  it.each(['mode', 'progress'] as const)('retains a PR Watch %s change and advances authority only for policy changes', (change) => {
    const target = {
      kind: 'session',
      sessionId: 'session-1',
      pullRequestLink: { repository: 'org/repo', number: 42 },
      policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'safe-yolo', approvals: { kind: 'off' }, newSession: { kind: 'off' } },
      pullRequestWatch: {
        policy: { mode: 'address', archiveAfterMerge: false },
        progress: { roundsStarted: 1, continuationRounds: 0 },
      },
    } satisfies ConversationBindingStateV1['target'];
    const current = binding({
      endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'org/repo#42', pullRequest: { repository: 'org/repo', number: 42 } },
      target,
    });
    const requestedTarget = {
      ...target,
      pullRequestWatch: change === 'mode'
        ? { ...target.pullRequestWatch, policy: { ...target.pullRequestWatch.policy, mode: 'autoFix' as const } }
        : { ...target.pullRequestWatch, progress: { ...target.pullRequestWatch.progress, roundsStarted: 2 } },
    };

    expect(transitionConversationBinding({ current, requested: { ...current, target: requestedTarget } })).toEqual({
      kind: 'updated',


      binding: { ...current, target: requestedTarget, authorityEpoch: change === 'mode' ? 8 : 7 },
    });
    expect(transitionConversationBinding({
      current,
      requested: { ...current, target: structuredClone(target) },
    })).toEqual({ kind: 'unchanged', binding: current });
  });

  it('treats a change from direct-only to addressed shared-message input as an authority change', () => {
    const current = binding();

    expect(transitionConversationBinding({
      current,
      requested: { ...current, inputMode: 'addressedMessages' },
    })).toMatchObject({
      kind: 'updated',


      binding: {
        inputMode: 'addressedMessages',
        authorityEpoch: 8,
      },
    });
  });

  it('preserves the chosen Session permission ceiling when an audience expands', () => {
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


      binding: {
        ...current,
        allowedPrincipalIds: ['principal-ada', 'principal-grace'],
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


      binding: {
        ...current,
        endpoint: { ...current.endpoint, label: 'Ada Lovelace' },
        senderFeedback: 'eligibleRefusals',
      },
    });
  });

  it('preserves an owner-requested ceiling for both narrowing and endpoint identity changes', () => {
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


      binding: {
        authorityEpoch: 4,
        target: { kind: 'session', policy: { permissionCeiling: 'yolo' } },
      },
    });
    expect(endpointChange).toMatchObject({
      kind: 'updated',


      binding: {
        authorityEpoch: 4,
        target: { kind: 'session', policy: { permissionCeiling: 'yolo', approvals: { kind: 'off' } } },
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


      binding: {
        authorityEpoch: 4,
        endpoint: { kind: 'thread', audience: 'shared', id: 'thread-1' },
        target: { kind: 'session', policy: { permissionCeiling: 'yolo' } },
      },
    });
  });

  it('treats only Automation identity and delivery policy as target authority', () => {
    const currentTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      policy: { resultDelivery: 'none' },
    } satisfies ConversationBindingStateV1['target'];
    const replacementTarget = {
      kind: 'automation',
      automationId: 'automation-2',
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


      binding: {
        authorityEpoch: 8,
        target: {
          kind: 'automation',
          automationId: 'automation-2',
        },
      },
    });
  });
});
