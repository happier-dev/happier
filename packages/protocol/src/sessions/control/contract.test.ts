import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

describe('sessionControl contract exports', () => {
  it('exports the manual unread cursor boundary helper', () => {
    expect(typeof (protocol as any).resolveManualUnreadCursorBoundary).toBe('function');
    expect((protocol as any).resolveManualUnreadCursorBoundary({
      sessionSeq: 8,
      lastViewedSessionSeq: null,
    })).toBe(7);
    expect((protocol as any).resolveManualUnreadCursorBoundary({
      sessionSeq: 8,
      lastViewedSessionSeq: 4,
    })).toBe(4);
    expect((protocol as any).resolveManualUnreadCursorBoundary({
      sessionSeq: 1,
      lastViewedSessionSeq: null,
    })).toBe(0);
  });

  it('exports base and per-command envelope schemas', () => {
    expect(typeof (protocol as any).SessionControlEnvelopeBaseSchema).toBe('object');
    expect(typeof (protocol as any).AuthStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionCreateEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsDescribeEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsExecuteEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunGetEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunActionEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamReadEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamCancelEnvelopeSchema).toBe('object');
  });

  it('exports and validates session catch-up authorization values', () => {
    const schema = (protocol as any).SessionCatchUpAuthorizationV1Schema;

    expect(schema.safeParse('explicit_cursor').success).toBe(true);
    expect(schema.safeParse('reconnect_watermark').success).toBe(true);
    expect(schema.safeParse('startup_recovery').success).toBe(true);
    expect(schema.safeParse('no_explicit_authorization').success).toBe(false);
  });

  it('validates a session_list envelope shape', () => {
    const schema = (protocol as any).SessionListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_list',
      data: {
        sessions: [
          {
            id: 'sess_123',
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 0,
            encryption: { type: 'dataKey' },
          },
        ],
        hasNext: false,
        nextCursor: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('validates primary turn status and sanitized runtime issue fields on session summaries', () => {
    expect(typeof (protocol as any).TurnTerminalStatusV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).PrimaryTurnStatusV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).SessionRuntimeIssueV1Schema?.safeParse).toBe('function');
    expect((protocol as any).TurnTerminalStatusV1Schema.safeParse('failed').success).toBe(true);
    expect((protocol as any).PrimaryTurnStatusV1Schema.safeParse('in_progress').success).toBe(true);

    const runtimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'auth_error',
      source: 'auth_error',
      occurredAt: 123,
      provider: 'codex',
      agentTurnId: 'turn_1',
      sanitizedPreview: 'Authentication failed',
    };

    const issueParsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse(runtimeIssue);
    expect(issueParsed.success).toBe(true);

    const summaryParsed = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      pendingBlockedCount: 1,
      latestTurnStatus: 'failed',
      lastRuntimeIssue: runtimeIssue,
      rollbackEligibleTurnStarts: [1, 3],
    });
    expect(summaryParsed.success).toBe(true);

    const invalidRollbackStarts = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      rollbackEligibleTurnStarts: [1, -1],
    });
    expect(invalidRollbackStarts.success).toBe(false);

    const invalidLatestTurnId = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      latestTurnId: 't'.repeat(192),
    });
    expect(invalidLatestTurnId.success).toBe(false);

    const invalidBlockedCount = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      pendingBlockedCount: -1,
    });
    expect(invalidBlockedCount.success).toBe(false);
  });

  it('validates public runtime activity projection fields on session summaries', () => {
    const summaryParsed = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(summaryParsed.success).toBe(true);

    const invalidCount = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivityActiveCount: -1,
    });
    expect(invalidCount.success).toBe(false);

    const invalidSourceClass = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivitySourceClass: 'claude_task_id',
    });
    expect(invalidSourceClass.success).toBe(false);
  });

  it('does not export dev-only primary turn projection compatibility payloads', () => {
    expect((protocol as any).LegacyPrimaryTurnProjectionMutationV1Schema).toBeUndefined();
    expect((protocol as any).PrimaryTurnProjectionMutationV1Schema).toBeUndefined();
    expect((protocol as any).buildSessionTurnMutationsFromLegacyPrimaryTurnProjectionMutation).toBeUndefined();
    expect((protocol as any).buildSessionTurnMutationsFromPrimaryTurnProjectionMutation).toBeUndefined();
    expect((protocol as any).resolveLegacyPrimaryTurnProjectionTurnId).toBeUndefined();
  });

  it('validates durable session turn mutation payloads', () => {
    expect(typeof (protocol as any).SessionTurnMutationV1Schema?.safeParse).toBe('function');

    const beginMutation = {
      v: 1,
      sessionId: 'sess_123',
      mutationId: 'mutation_123',
      action: 'begin',
      turnId: 'turn_123',
      provider: 'codex',
      agentTurnId: 'provider_turn_123',
      observedAt: 123,
    };

    expect((protocol as any).SessionTurnMutationV1Schema.safeParse(beginMutation).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...beginMutation,
      action: 'complete',
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...beginMutation,
      action: 'fail',
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'stream_error',
        source: 'stream_error',
        occurredAt: 123,
      },
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...beginMutation,
      agentTurnId: null,
    }).success).toBe(false);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...beginMutation,
      action: 'append_transcript_anchors',
      transcriptAnchors: {
        userMessageSeqs: [1, 2],
      },
    }).success).toBe(true);
    expect((protocol as any).SessionTurnMutationV1Schema.safeParse({
      ...beginMutation,
      action: 'end_session',
      turnId: undefined,
    }).success).toBe(true);
  });

  it('validates structured usage-limit issue details', () => {
    expect(typeof (protocol as any).SessionRuntimeUsageLimitDetailsV1Schema?.safeParse).toBe('function');

    const usageLimit = {
      v: 1,
      resetAtMs: 123_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'switch_account',
      planType: 'team',
      limitCategory: 'quota',
      quotaSnapshotRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-main',
        fetchedAtMs: 120_000,
      },
      effectiveMeterId: 'weekly',
      effectiveRemainingPct: 8,
      allWindows: [
        { meterId: 'daily', scope: 'daily', remainingPct: 30, resetAtMs: 150_000, status: 'ok' },
        { meterId: 'weekly', scope: 'weekly', remainingPct: 8, resetAtMs: 200_000, status: 'ok' },
      ],
      recoveryDecision: 'switching',
      connectedService: {
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-main',
        groupExhausted: false,
      },
    };

    const parsedDetails = (protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse(usageLimit);
    expect(parsedDetails.success).toBe(true);
    expect(parsedDetails.data.limitCategory).toBe('usage_limit');
    expect(parsedDetails.data.quotaSnapshotRef).toEqual({
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'codex-main',
      fetchedAtMs: 120_000,
    });
    expect((protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse({
      ...usageLimit,
      action: { kind: 'open_url' },
    }).success).toBe(false);
    expect((protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse({
      ...usageLimit,
      action: { kind: 'settings', url: 'https://example.com' },
    }).success).toBe(false);
    expect((protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse({
      ...usageLimit,
      action: { kind: 'open_url', url: 'https://example.com' },
    }).success).toBe(true);
    expect((protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse({
      ...usageLimit,
      limitCategory: 'capacity',
    }).success).toBe(true);
    expect((protocol as any).SessionRuntimeUsageLimitDetailsV1Schema.safeParse({
      ...usageLimit,
      limitCategory: 'quota',
      effectiveRemainingPct: 101,
    }).success).toBe(false);

    const issueParsed = (protocol as any).SessionRuntimeIssueV1Schema.safeParse({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'usage_limit',
      source: 'usage_limit',
      occurredAt: 123,
      usageLimit,
    });
    expect(issueParsed.success).toBe(true);
  });

  it('exports and validates the metadata-backed usage-limit recovery intent schema', () => {
    expect((protocol as any).SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID).toBe('runtime.usageLimitRecovery');
    expect((protocol as any).SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY).toBe('sessionUsageLimitRecoveryV1');

    const intent = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:s1:123',
      armedAtMs: 100,
      resetAtMs: 1_000,
      nextCheckAtMs: 1_050,
      attemptCount: 1,
      maxAttempts: 5,
      lastProbeError: null,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: 'work',
      },
    };

    const standardParsed = (protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse(intent);
    expect(standardParsed.success).toBe(true);
    expect(standardParsed.data.resumePromptMode).toBe('standard');
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: null,
      },
    }).success).toBe(true);
    const offParsed = (protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      resumePromptMode: 'off',
    });
    expect(offParsed.success).toBe(true);
    expect(offParsed.data.resumePromptMode).toBe('off');
    expect((protocol as any).SessionMetadataSchema.safeParse({
      sessionUsageLimitRecoveryV1: offParsed.data,
    }).success).toBe(true);
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      attemptCount: -1,
    }).success).toBe(false);
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      resumePromptMode: 'invalid',
    }).success).toBe(false);
    expect((protocol as any).SessionUsageLimitRecoveryV1Schema.safeParse({
      ...intent,
      recoveryCredits: {
        availableCount: 1,
        credits: [{
          id: 'reset-credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
          expiresAtMs: 1_700_100_000_000,
        }],
      },
    }).success).toBe(true);
  });

  it('exports and validates continuation recovery metadata used to gate pending drains', () => {
    expect((protocol as any).SESSION_CONTINUATION_RECOVERY_METADATA_KEY).toBe('sessionContinuationRecoveryV1');
    expect(typeof (protocol as any).SessionContinuationRecoveryV1Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).isSessionContinuationRecoveryBlockingPendingDrain).toBe('function');

    const metadata = {
      sessionContinuationRecoveryV1: {
        v: 1,
        attemptsById: {
          'generation-1:restart-1': {
            v: 1,
            attemptId: 'generation-1:restart-1',
            status: 'sending',
            failureAtMs: 100,
            updatedAtMs: 110,
            resumePromptMode: 'standard',
          },
        },
      },
    };

    expect((protocol as any).SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    expect((protocol as any).isSessionContinuationRecoveryBlockingPendingDrain(metadata)).toBe(true);
  });

  it('validates primary turn status and sanitized runtime issue fields on v2 session records', () => {
    const runtimeIssue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'permission_blocked',
      source: 'permission_blocked',
      occurredAt: 456,
      sessionSeq: 7,
      provider: 'claude',
    };

    const parsed = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      latestTurnStatus: 'failed',
      latestTurnStatusObservedAt: 456,
      lastRuntimeIssue: runtimeIssue,
      pendingRequestObservedAt: 789,
      latestReadyEventSeq: 8,
      latestReadyEventAt: 654,
      thinking: true,
      thinkingAt: 654,
      pendingBlockedCount: 1,
    });

    expect(parsed.success).toBe(true);

    const invalidObservedAt = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      latestTurnStatus: 'failed',
      latestTurnStatusObservedAt: -1,
    });
    expect(invalidObservedAt.success).toBe(false);

    const invalidAttentionProjection = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      thinkingAt: -1,
    });
    expect(invalidAttentionProjection.success).toBe(false);

    const invalidLatestTurnId = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      latestTurnId: 't'.repeat(192),
    });
    expect(invalidLatestTurnId.success).toBe(false);

    const invalidBlockedCount = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      pendingBlockedCount: -1,
    });
    expect(invalidBlockedCount.success).toBe(false);

    const catchUpAuthorization = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      initialTranscriptCatchUpAuthorization: 'explicit_cursor',
    });
    expect(catchUpAuthorization.success).toBe(true);

    const invalidCatchUpAuthorization = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      initialTranscriptCatchUpAuthorization: 'no_explicit_authorization',
    });
    expect(invalidCatchUpAuthorization.success).toBe(false);
  });

  it('validates public runtime activity projection fields on v2 session records', () => {
    const valid = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    expect(valid.success).toBe(true);

    const invalidExpiry = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'sess_123',
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      runtimeActivityExpiresAt: -1,
    });
    expect(invalidExpiry.success).toBe(false);
  });

  it('validates meaningful activity timestamps on v2 session records', () => {
    const schema = (protocol as any).V2SessionRecordSchema;
    const valid = schema.safeParse({
      id: 'sess_123',
      seq: 1,
      createdAt: 1,
      updatedAt: 4,
      meaningfulActivityAt: 3,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
    });
    expect(valid.success).toBe(true);

    const invalid = schema.safeParse({
      id: 'sess_123',
      seq: 1,
      createdAt: 1,
      updatedAt: 4,
      meaningfulActivityAt: -1,
      active: false,
      activeAt: 0,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
    });
    expect(invalid.success).toBe(false);
  });

  it('validates a session_wait envelope shape', () => {
    const schema = (protocol as any).SessionWaitEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_wait',
      data: { sessionId: 'sess_123', idle: true, observedAt: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_run_stream_read envelope shape', () => {
    const schema = (protocol as any).SessionRunStreamReadEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_run_stream_read',
      data: {
        sessionId: 'sess_123',
        runId: 'run_1',
        streamId: 'stream_1',
        events: [{ t: 'delta', textDelta: 'hi' }],
        nextCursor: 1,
        done: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_actions_list envelope shape', () => {
    const schema = (protocol as any).SessionActionsListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_list',
      data: {
        actionSpecs: [
          {
            id: 'review.start',
            title: 'Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: true,
              voice: true,
              agent: true,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts plugin-defined action ids in action discovery envelopes', () => {
    const schema = (protocol as any).SessionActionsDescribeEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_describe',
      data: {
        actionSpec: {
          id: 'acme.plugin.review.start',
          title: 'Plugin Review',
          description: 'Runs a plugin-defined review action',
          safety: 'safe',
          placements: [],
          slash: null,
          bindings: {
            mcpToolName: 'acme_plugin_review_start',
          },
          examples: null,
          surfaces: {
            ui: false,
            voice: false,
            agent: true,
            mcp: true,
            cli: true,
            rpc: false,
            sdk: false,
          },
          outputSchema: {},
          inputHints: null,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_actions_execute envelope shape', () => {
    const schema = (protocol as any).SessionActionsExecuteEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId: 'sess_123',
        actionId: 'review.start',
        result: { started: true },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates v2 session list and session-by-id wire responses', () => {
    const listSchema = (protocol as any).V2SessionListResponseSchema;
    const listParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_1',
          seq: 10,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 3,
          archivedAt: null,
          encryptionMode: 'plain',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          lastViewedSessionSeq: 4,
          pendingPermissionRequestCount: 2,
          pendingUserActionRequestCount: 1,
          pendingCount: 0,
          pendingVersion: 1,
          dataEncryptionKey: 'a2V5',
          share: { accessLevel: 'edit', canApprovePermissions: true },
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(listParsed.success).toBe(true);

    const invalidModeParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_bad',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          archivedAt: null,
          encryptionMode: 'nope',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          lastViewedSessionSeq: 4,
          pendingPermissionRequestCount: 0,
          pendingUserActionRequestCount: 0,
          dataEncryptionKey: null,
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(invalidModeParsed.success).toBe(false);

    const byIdSchema = (protocol as any).V2SessionByIdResponseSchema;
    const byIdParsed = byIdSchema.safeParse({
      session: {
        id: 'sess_1',
        seq: 10,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 3,
        metadata: 'm',
        metadataVersion: 1,
        agentState: 'a',
        agentStateVersion: 0,
        pendingCount: 0,
        dataEncryptionKey: null,
        encryptionMode: 'e2ee',
      },
    });
    expect(byIdParsed.success).toBe(true);
  });

  it('validates v2 session message responses', () => {
    const schema = (protocol as any).V2SessionMessageResponseSchema;
    const parsed = schema.safeParse({
      didWrite: true,
      message: {
        id: 'msg_1',
        seq: 12,
        localId: null,
        createdAt: 1700000000000,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('extracts system-session metadata safely', () => {
    const parsed = (protocol as any).readSystemSessionMetadataFromMetadata({
      metadata: {
        systemSessionV1: {
          v: 1,
          key: 'voice_carrier',
          hidden: true,
        },
      },
    });
    expect(parsed).toEqual({
      v: 1,
      key: 'voice_carrier',
      hidden: true,
    });

    expect((protocol as any).isHiddenSystemSession({ metadata: null })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier' } } })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier', hidden: true } } })).toBe(true);
  });

  it('reads systemSessionV1 independently of malformed sibling metadata keys', () => {
    // The system-session marker read must not depend on unrelated metadata fields
    // being well-formed: a corrupt recovery blob must not hide a system session.
    const parsed = (protocol as any).readSystemSessionMetadataFromMetadata({
      metadata: {
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        sessionUsageLimitRecoveryV1: { v: 'corrupt', nonsense: true },
        sessionContinuationRecoveryV1: 42,
      },
    });
    expect(parsed).toEqual({ v: 1, key: 'voice_conversation', hidden: true });
    expect((protocol as any).isHiddenSystemSession({
      metadata: {
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        sessionUsageLimitRecoveryV1: 42,
      },
    })).toBe(true);
  });

  it('returns null system-session metadata for non-object, absent, and malformed markers', () => {
    const read = (metadata: unknown) => (protocol as any).readSystemSessionMetadataFromMetadata({ metadata });
    expect(read(null)).toBeNull();
    expect(read(undefined)).toBeNull();
    expect(read('metadata-string')).toBeNull();
    expect(read(7)).toBeNull();
    expect(read({})).toBeNull();
    expect(read({ systemSessionV1: null })).toBeNull();
    expect(read({ systemSessionV1: { v: 2, key: 'x' } })).toBeNull();
    expect(read({ systemSessionV1: { v: 1 } })).toBeNull();
  });

  it('encodes and decodes v2 session list cursors', () => {
    const encode = (protocol as any).encodeV2SessionListCursorV1;
    const decode = (protocol as any).decodeV2SessionListCursorV1;

    expect(encode('sess_123')).toBe('cursor_v1_sess_123');
    expect(decode('cursor_v1_sess_123')).toBe('sess_123');
    expect(decode('cursor_v1_')).toBe(null);
    expect(decode('nope')).toBe(null);
  });

  it('encodes and decodes v2 session list cursors with meaningful activity', () => {
    const encode = (protocol as any).encodeV2SessionListCursorV2;
    const decode = (protocol as any).decodeV2SessionListCursorV2;

    const cursor = encode({ sessionId: 'sess_123', meaningfulActivityAt: 1700000000000 });
    expect(cursor).toMatch(/^cursor_v2_/);
    expect(decode(cursor)).toEqual({ sessionId: 'sess_123', meaningfulActivityAt: 1700000000000 });
    expect(decode('cursor_v2_not-json')).toBe(null);
    expect(decode('cursor_v1_sess_123')).toBe(null);
  });
});
