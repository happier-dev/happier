import { describe, expect, it } from 'vitest';

import {
  SessionPermissionDecisionActorV1Schema,
  SessionPermissionRemotePendingListOutputV1Schema,
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

  it('projects no permission request payload or exact rule to a remote mediator', () => {
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{ requestId: 'request-1', turnId: 'turn-1', createdAtMs: 1, allowedScopes: ['request', 'session'] }],
      truncated: false,
    }).success).toBe(true);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{ requestId: 'request-1', createdAtMs: 1, allowedScopes: ['request'] }],
      truncated: false,
    }).success).toBe(false);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{ requestId: 'request-1', turnId: ' turn-1 ', createdAtMs: 1, allowedScopes: ['request'] }],
      truncated: false,
    }).success).toBe(false);
    expect(SessionPermissionRemotePendingListOutputV1Schema.safeParse({
      requests: [{
        requestId: 'request-1',
        turnId: 'turn-1',
        createdAtMs: 1,
        allowedScopes: ['request'],
        toolName: 'bash',
      }],
      truncated: false,
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
});
