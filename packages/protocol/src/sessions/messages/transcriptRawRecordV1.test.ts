import { describe, expect, it } from 'vitest';

import {
  agentEventAttentionImpact,
  agentEventLocalIdAttentionImpact,
  buildAgentEventLocalId,
  TranscriptRawAgentEventV1Schema,
  TranscriptRawRecordV1Schema,
} from './transcriptRawRecordV1.js';

describe('TranscriptRawRecordV1Schema', () => {
  it('parses user text records with extra fields', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'user',
      content: { type: 'text', text: 'hello', extra: true },
      meta: { source: 'ui', model: null },
      unknownTopLevel: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses agent output records with unknown output data types', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'opaque_future_type',
          anything: { nested: true },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  describe('fail-soft malformed known output payloads', () => {
    const wrap = (data: Record<string, unknown>) => ({
      role: 'agent',
      content: { type: 'output', data },
    });

    it.each([
      ['assistant row without a message', { type: 'assistant', uuid: 'u1', isApiErrorMessage: true }],
      [
        'assistant row whose message role is missing',
        { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'hi' }] } },
      ],
      [
        'assistant row with null content',
        { type: 'assistant', uuid: 'u3', message: { role: 'assistant', content: null } },
      ],
      ['user row without a message', { type: 'user', uuid: 'u4' }],
      ['summary row without summary text', { type: 'summary', uuid: 'u5' }],
    ] satisfies ReadonlyArray<readonly [string, Record<string, unknown>]>)('accepts and preserves %s', (_name, data) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse(wrap(data));

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('expected fail-soft parse success');
      expect(parsed.data).toMatchObject(wrap(data));
    });

    it('still rejects malformed shared output envelope fields', () => {
      const parsed = TranscriptRawRecordV1Schema.safeParse(wrap({
        type: 'assistant',
        uuid: 42,
        isApiErrorMessage: true,
      }));

      expect(parsed.success).toBe(false);
    });

    it('still accepts well-formed assistant rows as the rich known variant', () => {
      const data = {
        type: 'assistant',
        uuid: 'u6',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hello' }],
        },
      };
      const parsed = TranscriptRawRecordV1Schema.safeParse(wrap(data));

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('expected well-formed parse success');
      expect(parsed.data).toMatchObject(wrap(data));
    });
  });

  it('accepts hyphenated tool-call blocks (normalized later)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                callId: 'call_1',
                name: 'Bash',
                input: { cmd: 'echo hi' },
              },
            ],
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses acp records with unknown data types (forward compatibility)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'future-provider',
        data: {
          type: 'some_future_event',
          any: { payload: true },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses terminal composer draft blocked session events', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'terminal-composer-draft-blocked',
      reason: 'idle_draft_guard',
      stateAtMs: 1_781_788_925_696,
      message: 'A terminal composer draft is blocking delivery.',
    });

    expect(parsed.success).toBe(true);
  });

  it('parses legacy codex tool-result sidechain records', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-result',
          callId: 'call_child_1',
          id: 'tool-result-legacy-1',
          output: 'ok',
          sidechainId: 'thread-child',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses canonical context compaction records including cancellation and retry metadata', () => {
    const acp = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'pi',
        data: {
          type: 'context-compaction',
          phase: 'cancelled',
          lifecycleId: 'pi:context-compaction',
          agentId: 'pi',
          trigger: 'threshold',
          source: 'agent-event',
          tokenCountBefore: 1200,
          tokenCountAfter: 700,
          retryAttempt: 1,
          sanitizedErrorPreview: 'cancelled by provider',
        },
      },
    });

    const sessionEvent = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event_context_compaction',
        data: {
          type: 'context-compaction',
          phase: 'completed',
          lifecycleId: 'pi:context-compaction',
          agentId: 'pi',
          trigger: 'manual',
          source: 'agent-event',
        },
      },
    });

    expect(acp.success).toBe(true);
    expect(sessionEvent.success).toBe(true);
  });

  it('rejects inconsistent context compaction paused metadata', () => {
    const invalidEvents = [
      {
        phase: 'failed',
        continuation: 'paused',
        pauseReason: 'agent-idle-after-compaction',
      },
      {
        phase: 'completed',
        pauseReason: 'agent-idle-after-compaction',
      },
    ];

    for (const event of invalidEvents) {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'event',
          id: 'event_context_compaction_invalid_paused',
          data: {
            type: 'context-compaction',
            source: 'agent-event',
            ...event,
          },
        },
      });

      expect(parsed.success).toBe(false);
    }
  });

  it('rejects inconsistent paused metadata in standalone context compaction events', () => {
    expect(TranscriptRawAgentEventV1Schema.safeParse({
      type: 'context-compaction',
      phase: 'failed',
      continuation: 'paused',
      pauseReason: 'agent-idle-after-compaction',
    }).success).toBe(false);
  });

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'parses codex %s lifecycle records',
    (type) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'codex',
          data: { type },
        },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'parses acp %s lifecycle records',
    (type) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'gemini',
          data: {
            type,
            id: 'turn_1',
          },
        },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'parses session task-lifecycle %s events',
    (event) => {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'event',
          id: 'event_1',
          data: {
            type: 'task-lifecycle',
            event,
          },
        },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it('parses structured provider quota and connected-service switch events', () => {
    const records = [
      {
        type: 'connected-service-account-switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'work',
        toProfileId: 'backup',
        reason: 'usage_limit',
        mode: 'restart_resume',
        effectiveRemainingPct: 12,
      },
      {
        type: 'agent-quota-wait',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-main',
        resetAtMs: 1_000,
        reason: 'usage_limit',
      },
      {
        type: 'agent-quota-recovered',
        serviceId: 'openai-codex',
        profileId: 'work',
        groupId: 'codex-main',
        reason: 'reset_confirmed',
      },
    ];

    for (const data of records) {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'event',
          id: `event_${data.type}`,
          data,
        },
      });

      expect(parsed.success).toBe(true);
    }
  });

  it('parses connected-service account switch events with native endpoints', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event_connected-service-account-switch_native',
        data: {
          type: 'connected-service-account-switch',
          serviceId: 'openai-codex',
          groupId: 'happier',
          fromProfileId: null,
          toProfileId: 'team',
          reason: 'manual',
          mode: 'restart_resume',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses connected-service account switch events with event-carried endpoint display labels', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch',
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      groupLabel: 'Team Pool',
      fromProfileId: 'batiplus',
      toProfileId: 'batiplus',
      fromProfileLabel: 'leeroy',
      toProfileLabel: null,
      reason: 'usage_limit',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== 'connected-service-account-switch') {
      throw new Error('expected a parsed connected-service-account-switch event');
    }
    expect(parsed.data.groupLabel).toBe('Team Pool');
    expect(parsed.data.fromProfileLabel).toBe('leeroy');
    expect(parsed.data.toProfileLabel).toBeNull();
  });

  it('rejects connected-service account switch display labels that are empty after trimming', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch',
      serviceId: 'claude-subscription',
      groupId: null,
      fromProfileId: 'batiplus',
      toProfileId: 'other',
      fromProfileLabel: '   ',
      reason: 'manual',
    });

    expect(parsed.success).toBe(false);

    const groupLabelParsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch',
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      groupLabel: '   ',
      fromProfileId: 'batiplus',
      toProfileId: 'other',
      reason: 'manual',
    });

    expect(groupLabelParsed.success).toBe(false);
  });

  it('parses connected-service switch attempts with explicit failed hot-apply outcome semantics', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
      errorCode: 'post_switch_verification_failed',
      diagnostic: {
        code: 'post_switch_verification_failed',
        failurePhase: 'post_switch_verification',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'codex-main',
        retryable: true,
        suggestedActions: ['retry', 'open_connected_accounts'],
      },
      partialState: 'runtime_auth_partially_applied',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect(parsed.data.attemptedContinuityMode).toBe('hot_apply');
    expect(parsed.data.outcome).toBe('failed');
    expect(parsed.data.outcomeAction).toBe('none');
  });

  it('parses connected-service switch attempts with explicit successful hot-apply outcome semantics', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'succeeded',
      outcomeAction: 'hot_applied',
      partialState: 'runtime_auth_applied',
    });

    expect(parsed.success).toBe(true);
  });

  it('preserves connected-service switch attempt verification details', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch-attempt-verification',
        data: {
          type: 'connected-service-account-switch-attempt',
          ok: true,
          action: 'hot_applied',
          verificationByServiceId: {
            'openai-codex': {
              status: 'weakly_verified',
              reason: 'provider_account_email_verified_without_account_id',
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    const content = parsed.data.content;
    expect(content.type).toBe('event');
    if (content.type !== 'event') throw new Error('expected event content');
    expect(content.data.type).toBe('connected-service-account-switch-attempt');
    if (content.data.type !== 'connected-service-account-switch-attempt') {
      throw new Error('expected connected-service account switch attempt');
    }
    expect(content.data.verificationByServiceId).toEqual({
      'openai-codex': {
        status: 'weakly_verified',
        reason: 'provider_account_email_verified_without_account_id',
      },
    });
  });

  it('keeps legacy connected-service switch attempt rows valid without outcome fields', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'hot_applied',
      errorCode: 'hot_apply_failed',
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects new-shape connected-service switch attempts that omit outcome semantics', () => {
    const attemptedHotApplyWithoutOutcome = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      errorCode: 'hot_apply_failed',
    });
    const diagnosticWithoutOutcome = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'hot_applied',
      diagnostic: {
        code: 'post_switch_verification_failed',
        failurePhase: 'post_switch_verification',
        source: 'runtime_auth_recovery',
        retryable: true,
        suggestedActions: ['retry'],
      },
    });
    const partialStateWithoutOutcome = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'hot_applied',
      partialState: 'runtime_auth_applied',
    });

    expect(attemptedHotApplyWithoutOutcome.success).toBe(false);
    expect(diagnosticWithoutOutcome.success).toBe(false);
    expect(partialStateWithoutOutcome.success).toBe(false);
  });

  it('rejects failed connected-service switch attempt outcomes that still claim a success action', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'hot_applied',
      errorCode: 'hot_apply_failed',
    });

    expect(parsed.success).toBe(false);
  });

  it('validates group-generation and per-session adoption projection fields on switch attempts', () => {
    const observed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      attemptedContinuityMode: 'metadata_only',
      outcome: 'observed',
      outcomeAction: 'metadata_updated',
      groupGeneration: 12,
      sessionAdoption: 'observed_only',
    });
    const applied = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      attemptedContinuityMode: 'metadata_only',
      outcome: 'succeeded',
      outcomeAction: 'metadata_updated',
      groupGeneration: 12,
      sessionAdoption: 'applied',
      sessionAdoptedGeneration: 12,
    });
    const negativeGeneration = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      outcome: 'observed',
      groupGeneration: -1,
      sessionAdoption: 'observed_only',
    });
    const unknownAdoption = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      outcome: 'observed',
      groupGeneration: 12,
      sessionAdoption: 'globally_active',
    });
    const failedButApplied = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: false,
      action: 'metadata_updated',
      outcome: 'failed',
      outcomeAction: 'none',
      groupGeneration: 12,
      sessionAdoption: 'applied',
      sessionAdoptedGeneration: 12,
    });
    const appliedWithoutGeneration = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      outcome: 'succeeded',
      outcomeAction: 'metadata_updated',
      sessionAdoption: 'applied',
    });
    const appliedMismatchedGeneration = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      outcome: 'succeeded',
      outcomeAction: 'metadata_updated',
      groupGeneration: 12,
      sessionAdoption: 'applied',
      sessionAdoptedGeneration: 11,
    });
    const observedOnlyWithAdoptedGeneration = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'metadata_updated',
      outcome: 'observed',
      outcomeAction: 'metadata_updated',
      groupGeneration: 12,
      sessionAdoption: 'observed_only',
      sessionAdoptedGeneration: 12,
    });

    expect(observed.success).toBe(true);
    expect(applied.success).toBe(true);
    expect(negativeGeneration.success).toBe(false);
    expect(unknownAdoption.success).toBe(false);
    expect(failedButApplied.success).toBe(false);
    expect(appliedWithoutGeneration.success).toBe(false);
    expect(appliedMismatchedGeneration.success).toBe(false);
    expect(observedOnlyWithAdoptedGeneration.success).toBe(false);
  });

  it('parses typed runtime-auth recovery transcript events with diagnostics', () => {
    const scheduled = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      attempt: 2,
      nextRetryAtMs: 1_900_000_000_000,
      diagnostic: {
        code: 'recovery_retry_scheduled',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'codex-main',
        retryable: true,
        suggestedActions: ['retry'],
      },
    });
    const deadLettered = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      attempt: 5,
      terminal: true,
      diagnostic: {
        code: 'recovery_dead_lettered',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'codex-main',
        retryable: false,
        suggestedActions: ['open_connected_accounts'],
      },
    });

    expect(scheduled.success).toBe(true);
    expect(deadLettered.success).toBe(true);
  });

  it('rejects runtime-auth recovery transcript events with non-runtime diagnostics', () => {
    const wrongSource = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      diagnostic: {
        code: 'recovery_retry_scheduled',
        failurePhase: 'runtime_auth_recovery',
        source: 'manual_auth_switch',
        retryable: true,
        suggestedActions: ['retry'],
      },
    });
    const wrongPhase = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
      serviceId: 'openai-codex',
      diagnostic: {
        code: 'recovery_dead_lettered',
        failurePhase: 'post_switch_verification',
        source: 'runtime_auth_recovery',
        retryable: false,
        suggestedActions: ['open_connected_accounts'],
      },
    });
    const missingScheduledDiagnostic = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
    });

    expect(wrongSource.success).toBe(false);
    expect(wrongPhase.success).toBe(false);
    expect(missingScheduledDiagnostic.success).toBe(false);
  });

  it('strips legacy provider state-sharing entry names from parsed events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event_agent-state-sharing-degraded',
        data: {
          type: 'agent-state-sharing-degraded',
          serviceId: 'pi',
          requestedStateMode: 'enabled',
          effectiveStateMode: 'disabled',
          code: 'state_sharing_unavailable',
          reason: 'Provider state sharing unavailable',
          entryName: 'sessions/--Users-alice-work-project--',
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.success ? parsed.data : null)).not.toContain('Users-alice-work-project');
    expect(JSON.stringify(parsed.success ? parsed.data : null)).not.toContain('entryName');
  });

  it('classifies connected-service auth maintenance events as non-unread system activity', () => {
    const maintenanceEvents = [
      { type: 'connected-service-account-switch', serviceId: 'openai-codex', groupId: 'group-1', fromProfileId: 'profile-a', toProfileId: 'profile-b', reason: 'usage_limit' },
      { type: 'connected-service-account-switch-deferral', policy: 'defer_until_turn_boundary' },
      { type: 'connected-service-account-switch-deferral-completed', reason: 'completed_at_boundary' },
      { type: 'connected-service-account-switch-deferral-superseded' },
      { type: 'connected-service-account-switch-attempt', ok: true, action: 'hot_applied', outcome: 'succeeded' },
      { type: 'agent-state-sharing-degraded', serviceId: 'pi', code: 'state_sharing_unavailable' },
      { type: 'agent-quota-wait', serviceId: 'openai-codex', groupId: 'group-1', resetAtMs: 1_900_000, reason: 'connected_service_group_quota_exhausted' },
      { type: 'agent-quota-recovered', serviceId: 'openai-codex', groupId: 'group-1', reason: 'fresh_quota_evidence' },
    ] as const;

    for (const event of maintenanceEvents) {
      expect(agentEventAttentionImpact(event)).toEqual({
        affectsUnread: false,
        affectsMeaningfulActivity: false,
      });
    }

    expect(agentEventAttentionImpact({ type: 'ready' })).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
  });

  it('classifies maintenance event local ids as non-unread system activity', () => {
    expect(agentEventLocalIdAttentionImpact('agent-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted')).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventLocalIdAttentionImpact('agent-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence')).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventLocalIdAttentionImpact('ready:local')).toBeNull();
    expect(agentEventLocalIdAttentionImpact('not-an-event')).toBeNull();
  });

  it('builds deterministic sanitized agent event local ids', () => {
    expect(buildAgentEventLocalId('agent-quota-wait', [
      'openai-codex',
      'main group',
      'reset_at_1900000',
    ])).toBe('agent-quota-wait:openai-codex:main_group:reset_at_1900000');
    expect(buildAgentEventLocalId('agent-quota-wait', [
      'openai-codex',
      'main group',
      'reset_at_1900000',
    ])).toBe(buildAgentEventLocalId('agent-quota-wait', [
      'openai-codex',
      'main group',
      'reset_at_1900000',
    ]));
  });

  it('classifies runtime-auth recovery maintenance attention by status', () => {
    expect(agentEventAttentionImpact({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
    })).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventAttentionImpact({
      type: 'connected-service-runtime-auth-recovery',
      status: 'recovered',
    })).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventAttentionImpact({
      type: 'connected-service-runtime-auth-recovery',
      status: 'cancelled',
    })).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventAttentionImpact({
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
    })).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
    expect(agentEventLocalIdAttentionImpact(
      'connected-service-runtime-auth-recovery:openai-codex:work:retry_scheduled',
    )).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventLocalIdAttentionImpact(
      'connected-service-runtime-auth-recovery:openai-codex:work:dead_lettered',
    )).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
    for (const reason of ['retry_scheduled', 'recovered', 'cancelled'] as const) {
      expect(agentEventLocalIdAttentionImpact(
        `connected-service-runtime-auth-recovery:openai-codex:group:profile:dead_lettered:1:false:${reason}`,
      )).toEqual({
        affectsUnread: true,
        affectsMeaningfulActivity: true,
      });
    }
  });

  it('parses assistant content blocks with unknown types (forward compatibility)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'new_block_type', payload: { ok: true } },
            ],
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('does not drop messages when usage shape changes (invalid usage is ignored)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              // Missing required token counts for our structured usage parser.
              output_tokens: 5,
              something_new: true,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect((parsed.success ? (parsed.data as any).content.data.message.usage : null)).toBeUndefined();
  });
});

describe('runtime-config-outcome agent event', () => {
  const baseEvent = {
    type: 'runtime-config-outcome' as const,
    runtime: 'unified',
    status: 'applied' as const,
    message: 'model switched to claude-opus',
  };

  it('accepts each of the five public statuses', () => {
    for (const status of [
      'applied',
      'requires_restart',
      'requires_interactive_control',
      'unsupported',
      'failed',
    ] as const) {
      const parsed = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, status });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects an unknown status enum value', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, status: 'queued' });
    expect(parsed.success).toBe(false);
  });

  it('accepts every public timing value and rejects unknown timing values', () => {
    for (const timing of [
      'current_window',
      'queued_until_safe_window',
      'scheduled_for_next_prompt',
      'next_idle',
      'before_next_prompt',
      'skipped_already_effective',
      'not_applicable',
    ] as const) {
      const parsed = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, timing });
      expect(parsed.success).toBe(true);
    }

    const rejected = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, timing: 'whenever' });
    expect(rejected.success).toBe(false);
  });

  it('accepts a sessionMode change key alongside the existing change keys', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      changes: [
        { key: 'sessionMode', requested: 'plan', effective: 'default' },
        { key: 'model', requested: 'claude-opus' },
        { key: 'reasoningEffort', requested: 'high' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown change key (strict change shape)', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      changes: [{ key: 'somethingNew', requested: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('passes through unknown top-level keys (back-compat property)', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      somethingFromANewerClient: { nested: true },
    });
    expect(parsed.success).toBe(true);
  });
});
