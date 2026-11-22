import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveCliApprovalDecisionPlacement } from './decisionPlacement';

const sessionCaller = {
  kind: 'session',
  sessionId: 'origin-session',
  starterDepth: 0,
  turnDepth: 0,
} as const;
// The Machine-signed carrier a forwarded Session Ask retains (the W17 `session.list` shape).
const authorization = {
  v: 1,
  token: 'carrier-token',
  binding: {
    accountId: 'owner',
    authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_home',
    machineId: 'origin-machine',
    installationId: 'installation',
    custodianAccountId: 'owner',
    accountEncryptionMode: 'plain',
    actionId: 'session.list',
    requestId: 'forwarded-request',
    requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'origin-machine' },
    sessionActionOrigin: {
      v: 1,
      caller: sessionCaller,
      sourceTurnId: 'turn-1',
      callerPermissionMode: 'read-only',
      requestId: 'forwarded-request',
    },
    sessionActionSource: {
      machineId: 'origin-machine',
      installationId: 'installation',
    },
  },
};

function sessionListAsk(signed: boolean) {
  const parsed = ApprovalRequestV2Schema.safeParse({
    v: 2,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'origin-session' },
    requestedSurface: 'agent',
    approval: { flow: 'deferred', result: 'required' },
    actionId: 'session.list',
    actionArgs: {},
    summary: 'List sessions',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'agent',
      caller: sessionCaller,
      serverId: 'home',
      serverIdentityId: 'srv_home',
      accountId: 'owner',
      machineId: 'origin-machine',
      target: { kind: 'machine', machineId: 'origin-machine' },
      actionId: 'session.list',
      requestId: 'forwarded-request',
      sessionListAccess: 'led_subtree',
      sessionId: 'origin-session',
      callerPermissionMode: 'read-only',
      sessionInputSource: {
        sourceSessionId: 'origin-session',
        sourceTurnId: 'turn-1',
        via: 'action',
      },
      ...(signed
        ? { externalActionExecutionAuthorization: authorization }
        : {}),
    },
  });
  if (!parsed.success) throw new Error(`fixture: ${parsed.error.message}`);
  return parsed.data;
}

describe('where a deciding CLI carries an approved decision', () => {
  it('hands a forwarded Session Ask to its origin daemon instead of executing under the Machine carrier', () => {
    expect(
      resolveCliApprovalDecisionPlacement({
        request: sessionListAsk(true),
        hostsMachineExecution: false,
        hasClientPort: false,
      }),
    ).toEqual({ kind: 'origin', machineId: 'origin-machine', executor: 'app' });
  });

  it('keeps an unsigned app-placed Ask in the deciding process', () => {
    expect(
      resolveCliApprovalDecisionPlacement({
        request: sessionListAsk(false),
        hostsMachineExecution: false,
        hasClientPort: false,
      }),
    ).toEqual({ kind: 'local' });
  });

  it('lets the origin daemon itself execute the forwarded Ask it receives', () => {
    expect(
      resolveCliApprovalDecisionPlacement({
        request: sessionListAsk(true),
        hostsMachineExecution: true,
        hasClientPort: false,
      }),
    ).toEqual({ kind: 'local' });
  });
});
