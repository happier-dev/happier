import { describe, expect, it } from 'vitest';

import {
  SessionPermissionDecisionActorV1Schema,
  SessionPermissionRemotePendingListOutputV1Schema,
  SessionUserActionRemoteAnswerInputV1Schema,
  SessionPermissionRemoteRespondInputV1Schema,
  SessionPermissionRemoteRespondOutputV1Schema,
} from './v1.js';

describe('Session permission mediation V1 schemas', () => {
  it('keeps account-user and plugin-asserted external-human audit actors distinct', () => {
    expect(SessionPermissionDecisionActorV1Schema.safeParse({
      kind: 'accountUser',
      accountId: 'account-1',
      relationship: 'owner',
    }).success).toBe(true);
    expect(SessionPermissionDecisionActorV1Schema.safeParse({
      kind: 'externalHuman',
      assurance: 'pluginAsserted',
      namespace: 'discord',
      principalId: 'user-1',
      assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    }).success).toBe(true);
    expect(SessionPermissionDecisionActorV1Schema.safeParse({
      kind: 'externalHuman',
      assurance: 'accountUser',
      namespace: 'discord',
      principalId: 'user-1',
      assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    }).success).toBe(false);
  });

  it('strictly bounds remote response input and excludes present-user effect fields', () => {
    const valid = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      idempotencyKey: 'retry-1',
      actor: { namespace: 'discord', principalId: 'user-1' },
      decision: 'allow',
      scope: 'request',
    };
    expect(SessionPermissionRemoteRespondInputV1Schema.safeParse(valid).success).toBe(true);
    const { turnId: _turnId, ...missingTurn } = valid;
    expect(SessionPermissionRemoteRespondInputV1Schema.safeParse(missingTurn).success).toBe(false);
    expect(SessionPermissionRemoteRespondInputV1Schema.safeParse({
      ...valid,
      turnId: ' turn-1 ',
    }).success).toBe(false);
    expect(SessionPermissionRemoteRespondInputV1Schema.safeParse({
      ...valid,
      allowedTools: ['bash'],
    }).success).toBe(false);
    expect(SessionPermissionRemoteRespondInputV1Schema.safeParse({
      ...valid,
      actor: { ...valid.actor, namespace: '€'.repeat(22) },
    }).success).toBe(false);
  });

  it('projects only bounded semantic permission summaries to a remote mediator', () => {
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        kind: 'permission',
        requestId: 'request-1',
        turnId: 'turn-1',
        createdAtMs: 1,
        allowedScopes: ['request', 'session'],
        agentRequestSummary: {
          kind: 'permission',
          toolLabel: 'Bash',
          title: 'Run: git status --short',
          detail: 'Command: git',
        },
      }],
      truncated: false,
      nextCursor: null,
    }).success).toBe(true);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        kind: 'permission',
        requestId: 'request-1',
        createdAtMs: 1,
        allowedScopes: ['request'],
        agentRequestSummary: {
          kind: 'permission',
          toolLabel: 'Bash',
          title: 'Run: git status --short',
          detail: 'Command: git',
        },
      }],
      truncated: false,
      nextCursor: null,
    }).success).toBe(false);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        kind: 'permission',
        requestId: 'request-1',
        turnId: ' turn-1 ',
        createdAtMs: 1,
        allowedScopes: ['request'],
        agentRequestSummary: {
          kind: 'permission',
          toolLabel: 'Bash',
          title: 'Run: git status --short',
          detail: 'Command: git',
        },
      }],
      truncated: false,
      nextCursor: null,
    }).success).toBe(false);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        kind: 'permission',
        requestId: 'request-1',
        turnId: 'turn-1',
        createdAtMs: 1,
        allowedScopes: ['request'],
        agentRequestSummary: {
          kind: 'permission',
          toolLabel: 'Bash',
          title: 'Run: git status --short',
          detail: 'Command: git',
        },
        toolName: 'bash',
      }],
      truncated: false,
      nextCursor: null,
    }).success).toBe(false);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        kind: 'permission',
        requestId: 'request-1',
        turnId: 'turn-1',
        createdAtMs: 1,
        allowedScopes: ['request'],
        agentRequestSummary: {
          kind: 'permission',
          toolLabel: 'Bash',
          title: 'Run a reviewed command',
          detail: 'Command: git',
          toolInput: { command: 'git status' },
          hiddenReasoning: 'private chain of thought',
          providerNativeUpdate: { type: 'setMode' },
        },
      }],
      truncated: false,
      nextCursor: null,
    }).success).toBe(false);

    expect(SessionPermissionRemoteRespondOutputV1Schema.safeParse({
      status: 'applied',
      settlementId: 'settlement-1',
      requestId: 'request-1',
      decision: 'allow',
      effect: { kind: 'allowOnce' },
    }).success).toBe(true);
    expect(SessionPermissionRemoteRespondOutputV1Schema.safeParse({
      status: 'applied',
      settlementId: 'settlement-1',
      requestId: 'request-1',
      decision: 'allow',
      effect: { kind: 'sessionGrant', grantId: 'grant-1', sourceRef: 'binding-1', sourceRevisionOrEpoch: 'rev-1', admittedPermissionCeiling: 'default', rule: { identifier: 'bash' } },
    }).success).toBe(false);
  });

  it('projects bounded semantic request summaries and admits only indexed remote question answers', () => {
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [
        {
          kind: 'permission',
          requestId: 'permission-1',
          turnId: 'turn-1',
          createdAtMs: 1,
          allowedScopes: ['request'],
          agentRequestSummary: {
            kind: 'permission',
            toolLabel: 'Bash',
            title: 'Run: git status --short',
            detail: 'Command: git',
          },
        },
        {
          kind: 'user_action',
          requestId: 'question-1',
          turnId: 'turn-2',
          createdAtMs: 2,
          agentRequestSummary: {
            kind: 'user_action',
            questions: [{
              question: 'Which branch should I use?',
              selection: 'single',
              required: true,
              allowCustom: false,
              choices: ['main', 'release'],
            }],
          },
        },
      ],
      truncated: false,
      nextCursor: null,
    }).success).toBe(true);

    // A user-action answer never carries a permission scope, free-form
    // request key, or source identity supplied by the chat client. The live
    // Session owner resolves its bounded indices against the current request.
    expect(SessionUserActionRemoteAnswerInputV1Schema.safeParse({
      sessionId: 'session-1',
      turnId: 'turn-2',
      requestId: 'question-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      answers: [{ questionIndex: 0, values: ['release'] }],
    }).success).toBe(true);
    expect(SessionUserActionRemoteAnswerInputV1Schema.safeParse({
      sessionId: 'session-1',
      turnId: 'turn-2',
      requestId: 'question-1',
      sourceRef: 'binding-1',
      sourceRevisionOrEpoch: 'rev-1',
      answers: [{ question: 'forged', values: ['release'] }],
    }).success).toBe(false);
  });
});
