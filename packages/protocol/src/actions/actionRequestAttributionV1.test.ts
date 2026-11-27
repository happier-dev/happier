import { describe, expect, it } from 'vitest';
import { deriveActionActorV1, deriveActionRequestActorV1, deriveSessionInputActionRequestAttributionV1, materializeActionRequestAttributionV1 } from './actionRequestAttributionV1.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import type { ActionCaller, ActionExecutorContext } from './executor/types.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { CoordinationMessageRefV1Schema } from '../discussions/messageRefs.js';
import { settleSessionInputRequestV1 } from '../sessions/messages/sessionInputAdmission.js';

describe('host request attribution custody', () => {
  const persona = { serverId: 'home', sessionId: 'bot' };

  it.each([false, true])('records a shared Machine requester independently of its custodian (plugin delegation: %s)', delegated => {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture',
      binding: { accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1',
        custodianAccountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home',
        machineId: 'machine', installationId: 'installation', actionId: delegated ? 'action.invoke' : 'review.start', requestId: 'request',
        target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43) } });
    const context = { surface: delegated ? 'plugin' : 'ui',
      authority: delegated ? 'account_automation' : 'present_user',
      actionCaller: delegated ? { kind: 'plugin', pluginId: 'happier.triage', initiatingCaller: { kind: 'host' } } : { kind: 'host' },
      runtimeAccountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
      externalActionExecutionAuthorization: authorization,
    } satisfies ActionExecutorContext;
    expect(deriveActionRequestActorV1(context, 'review.start'))
      .toEqual({ actorKind: 'person', accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1' });
    expect(deriveActionRequestActorV1({ ...context, actionRequestAttributionV1: {
      requestRef: 'uncaptured-person', persona, requester: null, origin: null,
    } }, 'review.start')).toBeUndefined();
  });

  it('keeps the requesting agent and original person when another person approves its effect', () => {
    expect(deriveActionRequestActorV1({ surface: 'ui', authority: 'present_user', runtimeAccountId: 'approver',
      actionCaller: { kind: 'host' }, approvedActionReplay: { origin: { surface: 'agent', accountId: 'custodian',
        caller: { kind: 'session', sessionId: 'asking-agent', starterDepth: 0, turnDepth: 0 } } },
      actionRequestAttributionV1: { requestRef: 'request', persona,
        requester: { serverId: 'original-home', accountId: 'requester' }, origin: null },
      presentUserApproval: { actionId: 'review.start', requestId: 'approved', inputDigest: 'digest',
        decidingAccountId: 'approver', decidedAtMs: 1 },
    }, 'review.start')).toEqual({ actorKind: 'agent', sessionId: 'asking-agent',
      onBehalfOf: { serverId: 'original-home', accountId: 'requester' } });
    expect(deriveActionRequestActorV1({ actionCaller: { kind: 'host' }, runtimeAccountId: 'custodian' }, 'review.start'))
      .toBeUndefined();
  });

  it('does not relabel a historical host request with its current approver', () => {
    expect(deriveActionRequestActorV1({ surface: 'ui', authority: 'present_user', runtimeAccountId: 'approver',
      actionCaller: { kind: 'host' }, approvedActionReplay: { origin: { surface: 'ui', accountId: 'custodian', caller: { kind: 'host' } } },
      presentUserApproval: { actionId: 'review.start', requestId: 'approved', inputDigest: 'digest',
        decidingAccountId: 'approver', decidedAtMs: 1 },
    }, 'review.start')).toBeUndefined();
  });

  it('names the witnessed approver instead of the requesting Session or its host Account', () => {
    expect(deriveActionActorV1({ runtimeAccountId: 'machine-owner',
      actionCaller: { kind: 'session', sessionId: 'bot', starterDepth: 0, turnDepth: 0 },
      presentUserApproval: { actionId: 'deployments.deploy', requestId: 'approved', inputDigest: 'digest',
        decidingAccountId: 'person', decidedAtMs: 1 },
    }, 'deployments.deploy')).toEqual({ actorKind: 'person', accountId: 'person' });
  });

  it('retains the original Session and qualified person through nested Plugin delegation', () => {
    expect(deriveActionActorV1({ actionCaller: { kind: 'plugin', pluginId: 'outer',
      initiatingCaller: { kind: 'plugin', pluginId: 'inner',
        initiatingCaller: { kind: 'session', sessionId: 'bot', starterDepth: 0, turnDepth: 0 } } },
      actionRequestAttributionV1: { requestRef: 'request', persona,
        requester: { serverId: 'original-home', accountId: 'person' }, origin: null },
    }, 'deployments.deploy')).toEqual({ actorKind: 'agent', sessionId: 'bot',
      onBehalfOf: { serverId: 'original-home', accountId: 'person' } });
  });

  it('keeps an accepted approval with an uncaptured person unknown rather than naming its requesting agent', () => {
    expect(deriveActionActorV1({ runtimeAccountId: 'execution-owner',
      actionCaller: { kind: 'session', sessionId: 'requesting-agent', starterDepth: 0, turnDepth: 0 },
      presentUserApproval: { actionId: 'deployments.deploy', requestId: 'historical-approval',
        inputDigest: 'digest', decidedAtMs: 1 },
    }, 'deployments.deploy')).toBeUndefined();
  });

  it('requires the existing present-person admission rather than a host Account or credential alone', () => {
    const actionCaller = { kind: 'host' } as const;
    const runtimeAccountId = 'machine-owner';
    expect(deriveActionActorV1({ actionCaller, runtimeAccountId }, 'deployments.deploy')).toBeUndefined();
    expect(deriveActionActorV1({ actionCaller, runtimeAccountId, surface: 'cli', authority: 'present_user' },
      'deployments.deploy')).toEqual({ actorKind: 'person', accountId: runtimeAccountId });
    const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture',
      binding: { accountId: runtimeAccountId, custodianAccountId: runtimeAccountId, principalId: 'machine-principal',
        credentialId: 'machine-credential', grant: API_TOKEN_FULL_GRANT_V1, accountEncryptionMode: 'plain',
        serverIdentityId: 'home', machineId: 'machine', installationId: 'installation', actionId: 'deployments.deploy',
        requestId: 'machine-request', target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43) } });
    expect(deriveActionActorV1({ actionCaller, runtimeAccountId, surface: 'cli', authority: 'present_user',
      externalActionExecutionAuthorization }, 'deployments.deploy')).toBeUndefined();
    expect(deriveActionRequestActorV1({ actionCaller, runtimeAccountId, surface: 'cli', authority: 'present_user',
      externalActionExecutionAuthorization }, 'deployments.deploy')).toBeUndefined();
  });

  it('keeps a settled unknown requester instead of substituting the Workflow starter', () => {
    const actionCaller = { kind: 'workflowRun', runId: 'run',
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'yolo' },
      authenticatedStarterV1: { requestRef: 'workflow-start', requester: { serverId: 'home', accountId: 'starter' } },
    } satisfies ActionCaller;
    expect(deriveActionActorV1({ actionCaller }, 'deployments.deploy')).toEqual({ actorKind: 'workflow', runId: 'run',
      onBehalfOf: { serverId: 'home', accountId: 'starter' } });
    expect(deriveActionActorV1({ actionCaller, actionRequestAttributionV1: {
      requestRef: 'autonomous-effect', persona, requester: null, origin: null,
    } }, 'deployments.deploy')).toEqual({ actorKind: 'workflow', runId: 'run' });
  });

  it('derives the requester from the receipt while retaining the distinct committed origin', () => {
    const origin = CoordinationMessageRefV1Schema.parse(SessionMessageRefV1Schema.parse({
      kind: 'session', session: persona, messageId: 'committed-message',
    }));
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount',
        actorAccountId: 'bob', sessionRelationship: 'sharedEditor' },
    })).toEqual({ requestRef: 'original-input', requester: { serverId: 'home', accountId: 'bob' }, persona, origin });
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })?.requester).toBeNull();
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: undefined,
    })).toBeUndefined();
  });

  it('keeps an earlier request immutable when a later caller mutates source objects', () => {
    const input = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' }, persona: { ...persona },
      origin: { kind: 'discussion' as const, discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'committed-post' } };
    const retained = materializeActionRequestAttributionV1(input);
    input.requester.accountId = 'carol';
    input.origin.messageId = 'later-post';
    expect(retained).toMatchObject({ requester: { accountId: 'bob' }, origin: { messageId: 'committed-post' } });
    expect(Object.isFrozen(retained.requester)).toBe(true);
    expect(Object.isFrozen(retained.origin)).toBe(true);
  });

  it('does not fabricate qualified attribution for a legacy Home, while preserving settled original custody', () => {
    const receipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'person', sessionRelationship: 'owner' };
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'input', persona: null, origin: null,
      messageRole: 'user', inputAdmissionReceipt: receipt })).toBeUndefined();
    const cause = { requestRef: 'original', requester: { serverId: 'original-home', accountId: 'person' }, persona,
      origin: { kind: 'session' as const, session: persona, messageId: 'original-message' } };
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'forwarded', persona: null, origin: null,
      messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
      inputAuthority: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
        sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'turn', via: 'action' },
        permission: { admittedPermissionCeiling: 'default' }, actionRequestAttributionV1: cause },
    })).toEqual(cause);
  });

  it('retains the admitted original cause on a forwarded machine input, never an Account-authored claim', () => {
    const cause = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' }, persona,
      origin: { kind: 'session' as const, session: persona, messageId: 'bob-message' } };
    const authority = { v: 1 as const, producer: 'sessionAction' as const, caller: { kind: 'host' as const },
      sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'sender-turn', via: 'action' as const },
      permission: { admittedPermissionCeiling: 'default' as const }, actionRequestAttributionV1: cause };
    const derive = (inputAdmissionReceipt: unknown) => deriveSessionInputActionRequestAttributionV1({
      requestRef: 'forwarded-input', persona: { serverId: 'home', sessionId: 'receiver' }, origin: null,
      messageRole: 'user', inputAdmissionReceipt, inputAuthority: authority,
    });
    expect(derive({ v: 1, issuer: 'authenticatedMachine' })).toEqual(cause);
    expect(derive({ v: 1, issuer: 'authenticatedAccount', actorAccountId: 'carol', sessionRelationship: 'owner' }))
      .toMatchObject({ requestRef: 'forwarded-input', requester: { accountId: 'carol' } });
    const { admittedPermissionCeiling: _, ...permission } = authority.permission;
    expect(() => settleSessionInputRequestV1({ request: { ...authority, permission },
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: {
        v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bot-owner', sessionRelationship: 'owner',
      } })).toThrow();
    expect(derive({ v: 1, issuer: 'authenticatedMachine' })?.requester?.accountId).toBe('bob');
  });
});
