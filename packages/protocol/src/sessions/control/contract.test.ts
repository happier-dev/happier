import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import {
  SessionLookupByTagsRequestV2Schema,
  SessionLookupByTagsResponseV2Schema,
  V2SessionByIdNotFoundSchema,
  V2SessionResourceAccessResponseSchema,
} from './contract.js';

describe('sessionControl contract exports', () => {
  it('accepts only the exact v2 session-by-id not-found body', () => {
    expect(protocol.V2SessionByIdNotFoundSchema).toBe(V2SessionByIdNotFoundSchema);

    expect(V2SessionByIdNotFoundSchema.safeParse({
      error: 'Session not found',
    }).success).toBe(true);
    expect(V2SessionByIdNotFoundSchema.safeParse({
      error: 'Session not found',
      path: '/v2/sessions/s_current_text_extra_404',
      method: 'GET',
    }).success).toBe(false);
  });

  it('validates the strict exact Session Resource access proof', () => {
    expect(protocol.V2SessionResourceAccessResponseSchema).toBe(V2SessionResourceAccessResponseSchema);

    expect(V2SessionResourceAccessResponseSchema.safeParse({
      accountId: 'account-a',
      throughCursor: 12,
      status: 'available',
    }).success).toBe(true);
    expect(V2SessionResourceAccessResponseSchema.safeParse({
      accountId: 'account-a',
      throughCursor: 12,
      status: 'unavailable',
    }).success).toBe(true);
    expect(V2SessionResourceAccessResponseSchema.safeParse({
      accountId: 'account-a',
      throughCursor: -1,
      status: 'available',
    }).success).toBe(false);
    expect(V2SessionResourceAccessResponseSchema.safeParse({
      accountId: 'account-a',
      throughCursor: 12,
      status: 'available',
      sessionId: 'not-a-wire-field',
    }).success).toBe(false);
  });

  it('validates the strict bounded session lookup-by-tags wire contract', () => {
    expect(protocol.SessionLookupByTagsRequestV2Schema).toBe(SessionLookupByTagsRequestV2Schema);
    expect(protocol.SessionLookupByTagsResponseV2Schema).toBe(SessionLookupByTagsResponseV2Schema);

    expect(SessionLookupByTagsRequestV2Schema.safeParse({
      tags: ['direct:v1:current', 'direct:v1:released', 'x'.repeat(256)],
    }).success).toBe(true);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({ tags: [] }).success).toBe(false);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({ tags: ['same', 'same'] }).success).toBe(false);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({ tags: ['one', 'two', 'three', 'four', 'five'] }).success).toBe(false);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({ tags: [''] }).success).toBe(false);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({ tags: ['x'.repeat(257)] }).success).toBe(false);
    expect(SessionLookupByTagsRequestV2Schema.safeParse({
      tags: ['one'],
      machineId: 'not-part-of-this-contract',
    }).success).toBe(false);

    const session = {
      id: 'lookup-session',
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      metadata: 'encrypted',
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
    };
    expect(SessionLookupByTagsResponseV2Schema.safeParse({
      sessions: [session, session, session, session],
    }).success).toBe(true);
    expect(SessionLookupByTagsResponseV2Schema.safeParse({
      sessions: [session, session, session, session, session],
    }).success).toBe(false);
    expect(SessionLookupByTagsResponseV2Schema.safeParse({ sessions: [], extra: true }).success).toBe(false);
  });

  it('validates the safe C9 transcript-authority projection without a raw source watermark', () => {
    const result = (protocol as any).V2SessionRecordSchema.safeParse({
      id: 'snapshot-session',
      seq: 12,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
      currentStorageState: 'snapshot_complete',
      acceptedThroughServerSeq: null,
      materializedThroughSourceAt: 1_700_000_000_000,
      publishedThroughServerSeq: 12,
      transcriptShareable: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      currentStorageState: 'snapshot_complete',
      publishedThroughServerSeq: 12,
      transcriptShareable: true,
    });
    expect(result.data).not.toHaveProperty('sourceWatermark');

    expect((protocol as any).V2SessionRecordSchema.safeParse({
      ...result.data,
      currentStorageState: 'snapshot_completish',
    }).success).toBe(false);
    expect((protocol as any).V2SessionRecordSchema.safeParse({
      ...result.data,
      transcriptShareable: 'yes',
    }).success).toBe(false);
  });

  it('types the split metadata layout and owner envelope on v2 session records', () => {
    const base = {
      id: 'split-session',
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: 'shared-envelope',
      metadataVersion: 3,
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'encrypted',
        c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
      },
      agentState: 'full-owner-state',
      agentStateVersion: 4,
      dataEncryptionKey: null,
      share: null,
    };

    expect(protocol.V2SessionRecordSchema.safeParse(base).success).toBe(true);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
    }).success).toBe(true);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      ownerMetadata: null,
    }).success).toBe(false);
    const {
      ownerMetadata: _ownerMetadata,
      agentState: _agentState,
      share: _share,
      ...sharedOnly
    } = base;
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...sharedOnly,
      share: { accessLevel: 'view', canApprovePermissions: false },
    }).success)
      .toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...sharedOnly,
      agentState: null,
      agentStateVersion: 4,
      share: { accessLevel: 'view', canApprovePermissions: false },
    }).success).toBe(true);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      metadataLayoutVersion: '1',
    }).success).toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      metadataLayoutVersion: 2,
    }).success).toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      ownerMetadata: 42,
    }).success).toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...base,
      ownerMetadata:
        'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
    }).success).toBe(false);
  });

  it('binds layout-one recipient metadata to the session share role', () => {
    const shared = {
      id: 'shared-session',
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: 'shared-envelope',
      metadataVersion: 3,
      metadataLayoutVersion: 1,
      agentState: null,
      agentStateVersion: 4,
      dataEncryptionKey: null,
      share: {
        accessLevel: 'edit',
        canApprovePermissions: true,
      },
    } as const;
    const ownerMetadata = {
      t: 'plain',
      v: { v: 1 },
    } as const;

    expect(protocol.V2SessionRecordSchema.safeParse(shared).success).toBe(true);
    const {
      share: _share,
      ...ambiguousRecipient
    } = shared;
    expect(protocol.V2SessionRecordSchema.safeParse(ambiguousRecipient).success)
      .toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...shared,
      ownerMetadata,
    }).success).toBe(false);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...shared,
      ownerMetadata,
      agentState: 'owner-agent-state',
    }).success).toBe(false);

    const owner = {
      ...shared,
      share: null,
      ownerMetadata,
      agentState: 'owner-agent-state',
    } as const;
    expect(protocol.V2SessionRecordSchema.safeParse(owner).success).toBe(true);
    const {
      ownerMetadata: _ownerMetadata,
      ...ownerWithSharedProjection
    } = owner;
    expect(protocol.V2SessionRecordSchema.safeParse(ownerWithSharedProjection).success)
      .toBe(false);

    const layoutZeroSharedCompatibility = {
      ...shared,
      metadataLayoutVersion: 0,
      agentState: 'released-layout-zero-agent-state',
    } as const;
    expect(protocol.V2SessionRecordSchema.safeParse(layoutZeroSharedCompatibility).success)
      .toBe(true);
  });

  it('keeps layout-zero Agent state required for released compatibility records', () => {
    const layoutZero = {
      id: 'legacy-session',
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: 'legacy-envelope',
      metadataVersion: 3,
      metadataLayoutVersion: 0,
      agentState: null,
      agentStateVersion: 4,
      dataEncryptionKey: null,
    };
    expect(protocol.V2SessionRecordSchema.safeParse(layoutZero).success)
      .toBe(true);
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...layoutZero,
      ownerMetadata: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
    }).success).toBe(false);
    const {
      metadataLayoutVersion: _metadataLayoutVersion,
      ...omittedLayout
    } = layoutZero;
    expect(protocol.V2SessionRecordSchema.safeParse({
      ...omittedLayout,
      ownerMetadata: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
    }).success).toBe(false);
    const {
      agentState: _agentState,
      agentStateVersion: _agentStateVersion,
      ...missingAgentState
    } = layoutZero;
    expect(protocol.V2SessionRecordSchema.safeParse(missingAgentState).success)
      .toBe(false);
  });

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

  it('validates a session_list envelope shape', () => {
    // Immutable cli-v0.2.0/cli-v0.1.0 preview and the current remote-dev
    // predecessor all emit this non-null E2EE shape.
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

  it('accepts current and legacy session_stop result shapes while rejecting mismatched outcomes', () => {
    const schema = (protocol as any).SessionStopEnvelopeSchema;
    const envelope = (data: unknown) => ({
      v: 1,
      ok: true,
      kind: 'session_stop',
      data,
    });

    expect(schema.safeParse(envelope({ sessionId: 'sess_123', stopped: true })).success).toBe(true);
    expect(schema.safeParse(envelope({ sessionId: 'sess_123', stopped: false })).success).toBe(true);
    expect(schema.safeParse(envelope({
      sessionId: 'sess_123',
      stopped: false,
      stopOutcome: {
        status: 'stopped_projection_unconfirmed',
        reason: 'relay_inactive_not_observed',
      },
    })).success).toBe(true);
    for (const reason of ['target_daemon_unavailable', 'target_session_not_found']) {
      expect(schema.safeParse(envelope({
        sessionId: 'sess_123',
        stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason },
      })).success).toBe(true);
    }

    for (const reason of [
      'terminal_control_serviceability_retirement_failed',
      'terminal_attachment_descriptor_retirement_failed',
    ]) {
      expect(schema.safeParse(envelope({
        sessionId: 'sess_123',
        stopped: false,
        stopOutcome: { status: 'stopped_cleanup_incomplete', reason },
      })).success).toBe(true);
      expect(schema.safeParse(envelope({
        sessionId: 'sess_123',
        stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason },
      })).success).toBe(false);
    }
  });

  it('represents unavailable Session encryption material explicitly without fabricating a key type', () => {
    const plainSummary = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_plain',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
      encryption: null,
    });
    expect(plainSummary.success).toBe(true);

    const retainedE2eeSummary = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_locked',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryptionMode: 'e2ee',
      encryption: null,
    });
    expect(retainedE2eeSummary.success).toBe(true);

    const missingEncryption = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_ambiguous',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
    });
    expect(missingEncryption.success).toBe(false);

    const fabricatedPlainEncryptionType = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_fabricated',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryptionMode: 'plain',
      encryption: { type: 'plain' },
    });
    expect(fabricatedPlainEncryptionType.success).toBe(false);
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
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
    });
    expect(summaryParsed.success).toBe(true);

    const invalidCount = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivityState: 'active',
      runtimeActivityRevision: 2,
    });
    expect(invalidCount.success).toBe(false);

    const invalidSourceClass = (protocol as any).SessionSummarySchema.safeParse({
      id: 'sess_123',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      encryption: { type: 'dataKey' },
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
      runtimeActivitySourceClass: 'agent_detached_task',
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
      // The canonical owner upgrades legacy bare service ids to the qualified
      // Connected Account service key of the owning Agent.
      serviceId: 'happier.agent.codex/openai-codex',
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
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
    });
    expect(valid.success).toBe(true);

    const invalidRevision = (protocol as any).V2SessionRecordSchema.safeParse({
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
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: -1,
    });
    expect(invalidRevision.success).toBe(false);
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
              api: false,
              plugin: false,
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
            api: false,
            plugin: false,
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
      attentionNextCursor: 'cursor_v2_attention',
      attentionHasNext: true,
    });
    expect(listParsed.success).toBe(true);
    expect(listParsed.success && listParsed.data).toMatchObject({
      attentionNextCursor: 'cursor_v2_attention',
      attentionHasNext: true,
    });

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
        retiredUnknownMetadata: 42,
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
