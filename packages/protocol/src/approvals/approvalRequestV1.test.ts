import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from '../actions/actionIds.js';
import {
  ApprovalRequestSchema,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  requiresExactDaemonApprovalReplay,
} from './approvalRequestV1.js';
import { readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { parseSessionBoardActionPortResultV1 } from '../sessions/board/actions.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';

describe('ApprovalRequestV1Schema', () => {
  it('exposes only strict request-bound Board failure details from current approval artifacts', () => {
    const currentRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const base = {
      v: 2,
      status: 'failed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      actionId: 'session.board.layout.update',
      actionArgs: {
        sessionId: 'session-1',
        expectedLayoutRevision: null,
        operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
      },
      summary: 'Create Board view',
      executionOriginV1: {
        v: 1,
        authority: 'present_user',
        surface: 'ui',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.board.layout.update',
        requestId: 'request-1',
      },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: false,
        errorCode: 'session_board_revision_conflict',
        error: 'session_board_revision_conflict',
        details: { currentLayoutRevision: currentRevision },
      },
    } as const;

    const valid = ApprovalRequestV2Schema.safeParse(base);
    expect(valid.success).toBe(true);
    if (!valid.success) throw new Error('expected valid Board approval fixture');
    expect(readApprovalExecutionFailure(valid.data)).toMatchObject({
      details: { currentLayoutRevision: currentRevision },
    });
    const unsafe = ApprovalRequestV2Schema.parse({
      ...base,
      execution: {
        ...base.execution,
        details: { currentLayoutRevision: currentRevision, bearer: 'must-not-persist' },
      },
    });
    expect(parseSessionBoardActionPortResultV1('session.board.layout.update', base.actionArgs, {
      ok: false, errorCode: base.execution.errorCode, error: base.execution.error,
      details: unsafe.execution?.ok === false ? unsafe.execution.details : undefined,
    }).success).toBe(false);
    expect(readApprovalExecutionFailure(unsafe)).toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: currentRevision },
    });
    const otherAction = ApprovalRequestV2Schema.parse({
      ...base,
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Title' },
      executionOriginV1: {
        ...base.executionOriginV1,
        actionId: 'session.title.set',
      },
    });
    expect(readApprovalExecutionFailure(otherAction)).toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
    });
  });

  it('parses a minimal open approval request', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.status).toBe('open');
    expect(parsed.actionId).toBe('review.start');
  });

  it('keeps legacy failed approvals readable without trusting opaque detail bags', () => {
    const legacy = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'failed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Title' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: false,
        errorCode: 'action_failed',
        error: 'action_failed',
        details: { bearer: 'legacy-untrusted-value' },
      },
    });

    expect(readApprovalExecutionFailure(legacy)).toEqual({
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
    });
  });

  it('keeps released V1 readable but rejects the V2 epoch', () => {
    const legacy = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Legacy' },
      summary: 'Set title',
    } as const;
    const current = {
      ...legacy,
      v: 2,
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV1Schema.safeParse(legacy).success).toBe(true);
    expect(ApprovalRequestV1Schema.safeParse(current).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(current).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(legacy).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(current).success).toBe(true);
  });

  it('keeps executing exclusive to current V2 approval requests', () => {
    const current = {
      v: 2,
      status: 'executing',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Approved' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 1 },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'cli',
        caller: { kind: 'host' },
        serverId: 'home-1',
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(current).success).toBe(true);
    expect(ApprovalRequestV1Schema.safeParse({ ...current, v: 1 }).success).toBe(false);
  });

  it('requires a strict secret-free execution origin on V2', () => {
    const base = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Approved' },
      summary: 'Set title',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'agent',
        caller: {
          kind: 'plugin',
          pluginId: 'plugin.example',
          contributionLocalId: 'tool',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'generation-1',
            installSource: 'npm',
          },
        },
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 's1',
        machineId: 'machine-1',
        runId: 'run-1',
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(base).success).toBe(true);
    const permissionOrigin = {
      ...base.executionOriginV1,
      callerPermissionMode: 'safe-yolo',
      sessionAgentSpawnPolicyV1: { permissionCeiling: 'read-only' },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
      sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'mcp' },
    };
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: permissionOrigin }).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, callerPermissionMode: 'invented-mode',
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, sessionAgentSpawnPolicyV1: { permissionCeiling: 'invented-mode' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, sessionAgentSpawnPolicyV1: { bearer: 'secret' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, causalPermissionAuthority: { ...permissionOrigin.causalPermissionAuthority, bearer: 'secret' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: undefined }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: { ...base.executionOriginV1, bearer: 'secret-token' },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        caller: { ...base.executionOriginV1.caller, occurrenceId: 'process-local' },
      },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, unknown: true }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        target: { kind: 'session', sessionId: 'other-session' },
      },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        accountId: undefined,
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    }).success).toBe(false);
  });

  it('binds an API approval to the complete encrypted Machine target', () => {
    const bindingTarget = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: {
        machineId: 'machine-1',
        directory: '/workspace/original',
        workspaceRefId: 'workspace-1',
      },
    };
    const request = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        serverIdentityId: 'home-identity-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        machineId: 'machine-1',
        target: {
          ...bindingTarget,
          project: { ...bindingTarget.project, directory: '/workspace/substituted' },
        },
        actionId: 'session.list',
        requestId: 'request-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-authorization',
          binding: {
            serverIdentityId: 'home-identity-1',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            machineId: 'machine-1',
            actionId: 'session.list',
            requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: bindingTarget,
            grant: API_TOKEN_FULL_GRANT_V1,
          },
        },
      },
    };

    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(false);
  });

  it('retains the exact resolved Session for an approval relayed through its selected Machine', () => {
    const request = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Approved title' },
      summary: 'Set title',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-profile-1',
        serverIdentityId: 'home-identity-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-authorization',
          binding: {
            serverIdentityId: 'home-identity-1',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            machineId: 'machine-1',
            actionId: 'session.title.set',
            requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-1' },
            grant: API_TOKEN_FULL_GRANT_V1,
          },
        },
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(true);
  });

  it('parses optional approval routing metadata while preserving old artifacts', () => {
    const oldArtifact = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });
    const newArtifact = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      approval: { flow: 'blocking', result: 'required' },
    });

    expect(oldArtifact.approval).toBeUndefined();
    expect(newArtifact.approval).toEqual({ flow: 'blocking', result: 'required' });
  });

  it('parses transcript tool-call origin metadata', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      origin: {
        kind: 'transcript_tool_call',
        sessionId: 's1',
        messageId: 'msg-1',
        toolCallId: 'tool-1',
        toolName: 'session_list',
        toolInput: { limit: 20 },
      },
    });

    expect(parsed.origin).toEqual({
      kind: 'transcript_tool_call',
      sessionId: 's1',
      messageId: 'msg-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 20 },
    });
  });

  it('rejects malformed transcript tool-call origin metadata', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      origin: {
        kind: 'transcript_tool_call',
        messageId: 'msg-1',
      },
    })).toThrow(/origin/i);
  });

  it('rejects malformed approval routing metadata', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      approval: { result: 'optional' },
    })).toThrow(/flow/i);
  });

  it('accepts createdBy.surface=cli for requests created from the CLI surface', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.createdBy.surface).toBe('cli');
    expect(parsed.createdBy.sessionId).toBe('s1');
  });

  it('allows cli as a createdBy surface', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.createdBy.surface).toBe('cli');
  });

  it('rejects open requests that already include a decision or execution payload', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      decision: { kind: 'approve', decidedAtMs: 2 },
    })).toThrow(/decision/i);

    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      execution: { executedAtMs: 3, ok: true },
    })).toThrow(/execution/i);
  });

  it('requires a decision for approved, rejected, executed, and failed requests', () => {
    for (const status of ['approved', 'rejected', 'executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
      })).toThrow(/decision/i);
    }
  });

  it('requires execution metadata for executed and failed requests', () => {
    for (const status of ['executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: 'approve', decidedAtMs: 2 },
      })).toThrow(/execution/i);
    }
  });

  it('rejects execution metadata before an approval reaches executed or failed', () => {
    for (const status of ['approved', 'rejected', 'canceled'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        ...(status === 'canceled' ? {} : { decision: { kind: status === 'approved' ? 'approve' : 'reject', decidedAtMs: 2 } }),
        execution: { executedAtMs: 3, ok: true, result: { ok: true } },
      })).toThrow(/execution/i);
    }
  });

  it('rejects decision kinds that do not match the approval status', () => {
    const cases = [
      { status: 'approved', decisionKind: 'reject' },
      { status: 'rejected', decisionKind: 'approve' },
      { status: 'executed', decisionKind: 'reject', execution: { executedAtMs: 3, ok: true } },
      { status: 'failed', decisionKind: 'reject', execution: { executedAtMs: 3, ok: false } },
      { status: 'canceled', decisionKind: 'reject' },
    ] as const;

    for (const entry of cases) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status: entry.status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: entry.decisionKind, decidedAtMs: 2 },
        ...(entry.execution ? { execution: entry.execution } : {}),
      })).toThrow(/decision/i);
    }
  });

  it('rejects execution outcomes that do not match the approval status', () => {
    const cases = [
      { status: 'executed', executionOk: false },
      { status: 'failed', executionOk: true },
    ] as const;

    for (const entry of cases) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status: entry.status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: entry.executionOk },
      })).toThrow(/execution/i);
    }
  });

  it('reads the released session picker V1 artifact without restoring its executable Action id', () => {
    const releasedV1Artifact = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.spawn_picker',
      actionArgs: { tag: 'release-history', initialMessage: 'Choose a session target' },
      summary: 'Choose a session target',
    } as const;

    expect(ApprovalRequestV1Schema.safeParse(releasedV1Artifact).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(releasedV1Artifact).success).toBe(true);
    expect(ActionIdSchema.safeParse('session.spawn_picker').success).toBe(false);
    expect(ApprovalRequestV1Schema.safeParse({
      ...releasedV1Artifact,
      actionId: 'session.arbitrary_retired_action',
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...releasedV1Artifact,
      v: 2,
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        actionId: 'session.spawn_picker',
        requestId: 'request-1',
      },
    }).success).toBe(false);
  });
});

describe('requiresExactDaemonApprovalReplay', () => {
  it('keeps host Agent/MCP Account security requests on the deciding human Home adapter', () => {
    for (const surface of ['agent', 'mcp'] as const) {
      const approval = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface, sessionId: 'session-1' }, requestedSurface: surface,
        actionId: 'account.apiTokens.revokeAll', actionArgs: {}, summary: 'Revoke tokens',
        executionOriginV1: { v: 1, authority: 'account_automation', surface,
          caller: { kind: 'host' }, serverId: 'home', actionId: 'account.apiTokens.revokeAll',
          requestId: 'request', sessionId: 'session-1', target: { kind: 'session', sessionId: 'session-1' } },
      });
      expect(requiresExactDaemonApprovalReplay(approval)).toBe(false);
    }
  });
  function approvalWithCaller(caller: unknown): unknown {
    return {
      v: 2,
      status: 'approved',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Reviewed title' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: {
        v: 1,
        authority: 'present_user',
        surface: 'ui',
        caller,
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    };
  }

  it('routes every caller whose currentness only the admitting daemon owns', () => {
    const host = ApprovalRequestV2Schema.parse(approvalWithCaller({ kind: 'host' }));
    expect(requiresExactDaemonApprovalReplay(host)).toBe(false);

    const sessionCaller = { kind: 'session', sessionId: 'session-caller', starterDepth: 2, turnDepth: 3 };
    const session = ApprovalRequestV2Schema.parse(approvalWithCaller(sessionCaller));
    expect(session.executionOriginV1.caller).toEqual(sessionCaller);
    expect(requiresExactDaemonApprovalReplay(session)).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, capability: 'secret' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, sessionId: ' ' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ kind: 'session', sessionId: 'session-caller' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, starterDepth: undefined })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, turnDepth: -1 })).success).toBe(false);

    const workflowRun = ApprovalRequestV2Schema.parse(approvalWithCaller({
      kind: 'workflowRun',
      runId: 'workflow-run-1',
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: {
          kind: 'api',
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
        },
      },
    }));
    expect(requiresExactDaemonApprovalReplay(workflowRun)).toBe(true);

    const automationCaller = {
      kind: 'automationRun',
      runId: 'automation-run-1',
      automationId: 'automation-1',
      cause: { kind: 'manual', invokedAt: 1_700_000_000_000 },
    } as const;
    const automationRun = ApprovalRequestV2Schema.parse({
      ...approvalWithCaller(automationCaller) as Record<string, unknown>,
      executionOriginV1: {
        ...(approvalWithCaller(automationCaller) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
        runId: 'automation-run-1',
      },
    });
    expect(requiresExactDaemonApprovalReplay(automationRun)).toBe(true);
  });

  it('keeps every non-present-human surface on the exact daemon', () => {
    for (const surface of ['agent', 'mcp', 'cli', 'rpc'] as const) {
      const request = ApprovalRequestV2Schema.parse({
        ...approvalWithCaller({ kind: 'host' }) as Record<string, unknown>,
        requestedSurface: surface,
        executionOriginV1: {
          ...(approvalWithCaller({ kind: 'host' }) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
          authority: 'account_automation',
          surface,
        },
      });
      expect(requiresExactDaemonApprovalReplay(request), surface).toBe(true);
    }

    const apiRequest = ApprovalRequestV2Schema.parse({
      ...approvalWithCaller({ kind: 'host' }) as Record<string, unknown>,
      requestedSurface: 'api',
      executionOriginV1: {
        ...(approvalWithCaller({ kind: 'host' }) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
        authority: 'account_automation',
        surface: 'api',
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    });
    expect(requiresExactDaemonApprovalReplay(apiRequest)).toBe(true);
  });
});
