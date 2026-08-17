import { describe, expect, it } from 'vitest';

import {
  agentEventAttentionImpact,
  agentEventLocalIdAttentionImpact,
  TranscriptRawAgentEventV1Schema,
  TranscriptRawRecordV1Schema,
  type TranscriptRawAgentEventV1,
  type RuntimeConfigOutcomeChangeKeyV1,
  type RuntimeConfigOutcomeStatusV1,
  type RuntimeConfigOutcomeTimingV1,
} from './transcriptRawRecordV1.js';
import * as transcriptProtocol from './transcriptRawRecordV1.js';
import {
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY,
} from '../sessionAgentTransitionDivider.js';

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

  describe('fail-soft malformed known output payloads', () => {
    const wrap = (data: Record<string, unknown>) => ({
      role: 'agent',
      content: { type: 'output', data },
    });

    it.each([
      [
        'assistant row without a message',
        { type: 'assistant', uuid: 'u1', isApiErrorMessage: true },
      ],
      [
        'assistant row whose message role is missing',
        { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'hi' }] } },
      ],
      [
        'assistant row with null content',
        { type: 'assistant', uuid: 'u3', message: { role: 'assistant', content: null } },
      ],
      [
        'user row without a message',
        { type: 'user', uuid: 'u4' },
      ],
      [
        'summary row without summary text',
        { type: 'summary', uuid: 'u5' },
      ],
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

    it('still accepts well-formed assistant rows as the rich known variant (no regression)', () => {
      const parsed = TranscriptRawRecordV1Schema.safeParse(wrap({
        type: 'assistant',
        uuid: 'u4',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hello' }],
        },
      }));
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('expected well-formed parse success');
      expect(parsed.data).toMatchObject(wrap({
        type: 'assistant',
        uuid: 'u4',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hello' }],
        },
      }));
    });
  });

  it('parses acp records with unknown data types (forward compatibility)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'future-provider',
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
      stateAtMs: 1781788925696,
      message: 'A terminal composer draft is blocking delivery.',
    });

    expect(parsed.success).toBe(true);
  });

  it('classifies maintenance events as non-unread system activity', () => {
    const maintenanceEventTypes = [
      'connected-service-account-switch',
      'connected-service-account-switch-deferral',
      'connected-service-account-switch-deferral-completed',
      'connected-service-account-switch-deferral-superseded',
      'connected-service-account-switch-attempt',
      'provider-state-sharing-degraded',
      'provider-quota-wait',
      'provider-quota-recovered',
    ] as const satisfies ReadonlyArray<TranscriptRawAgentEventV1['type']>;

    for (const type of maintenanceEventTypes) {
      expect(agentEventAttentionImpact({ type })).toEqual({
        affectsUnread: false,
        affectsMeaningfulActivity: false,
      });
    }

    expect(agentEventAttentionImpact({
      type: 'ready',
    })).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
  });

  it('classifies maintenance event local ids as non-unread system activity', () => {
    expect(agentEventLocalIdAttentionImpact('provider-quota-wait:quota-blocked_openai-codex_main:reset_at_1900000:connected_service_group_quota_exhausted')).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventLocalIdAttentionImpact('provider-quota-recovered:quota-blocked_openai-codex_main:reset_at_1900000:fresh_quota_evidence')).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
    expect(agentEventLocalIdAttentionImpact('ready:local')).toBeNull();
    expect(agentEventLocalIdAttentionImpact('not-an-event')).toBeNull();
  });

  it('builds deterministic sanitized agent event local ids', () => {
    const buildAgentEventLocalId = (transcriptProtocol as Record<string, unknown>).buildAgentEventLocalId;
    expect(typeof buildAgentEventLocalId).toBe('function');
    if (typeof buildAgentEventLocalId !== 'function') return;

    expect(buildAgentEventLocalId('provider-quota-wait', [
      'openai-codex',
      'main group',
      'reset_at_1900000',
    ])).toBe('provider-quota-wait:openai-codex:main_group:reset_at_1900000');
    expect(buildAgentEventLocalId('provider-quota-wait', [
      'openai-codex',
      'main group',
      'reset_at_1900000',
    ])).toBe(buildAgentEventLocalId('provider-quota-wait', [
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

  it('classifies the same-Session transition divider as no user attention', () => {
    expect(agentEventAttentionImpact({
      type: 'message',
      message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
      [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: {
        v: 1,
        fromAgentId: 'claude',
        toAgentId: 'codex',
      },
    } as unknown as TranscriptRawAgentEventV1)).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
  });

  it('keeps ordinary passthrough message events attention-bearing', () => {
    // Guards the "add `message` to the no-attention allowlist" shortcut, which
    // would silence every unrelated informational passthrough event.
    expect(agentEventAttentionImpact({
      type: 'message',
      message: 'Something the user should see.',
    } as unknown as TranscriptRawAgentEventV1)).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
  });

  it('does not silence a malformed or wrong-version transition sidecar', () => {
    const malformedSidecars: ReadonlyArray<unknown> = [
      { v: 2, fromAgentId: 'claude', toAgentId: 'codex' },
      { v: 1, fromAgentId: '', toAgentId: 'codex' },
      { v: 1, fromAgentId: 'claude' },
      { v: 1, fromAgentId: 'claude', toAgentId: 'codex', extra: 'nope' },
      'not-an-object',
      null,
    ];
    for (const sidecar of malformedSidecars) {
      expect(agentEventAttentionImpact({
        type: 'message',
        message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
        [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: sidecar,
      } as unknown as TranscriptRawAgentEventV1)).toEqual({
        affectsUnread: true,
        affectsMeaningfulActivity: true,
      });
    }
  });

  it('does not treat a transition sidecar on a non-message event as a divider', () => {
    expect(agentEventAttentionImpact({
      type: 'ready',
      [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: {
        v: 1,
        fromAgentId: 'claude',
        toAgentId: 'codex',
      },
    } as unknown as TranscriptRawAgentEventV1)).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
  });

  it('parses codex turn_aborted lifecycle records', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'turn_aborted',
        },
      },
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

  it('parses codex terminal primary turn lifecycle records', () => {
    for (const type of ['turn_failed', 'turn_cancelled', 'turn_aborted'] as const) {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type,
          },
        },
      });

      expect(parsed.success).toBe(true);
    }
  });

  it('parses acp terminal primary turn lifecycle records', () => {
    for (const type of ['turn_failed', 'turn_cancelled', 'turn_aborted'] as const) {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'claude',
          data: {
            type,
            id: 'turn_1',
          },
        },
      });

      expect(parsed.success).toBe(true);
    }
  });

  it('parses canonical context compaction records including cancellation and retry attempt metadata', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-compact-cancelled',
        data: {
          type: 'context-compaction',
          phase: 'cancelled',
          source: 'provider-event',
          lifecycleId: 'compact_1',
          tokenCountBefore: 1200,
          tokenCountAfter: 320,
          retryAttempt: 2,
          sanitizedErrorPreview: 'cancelled by provider',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.content.type === 'event') {
      expect(parsed.data.content.data).toMatchObject({
        type: 'context-compaction',
        phase: 'cancelled',
        retryAttempt: 2,
      });
    }
  });

  it('parses connected-service account switch deferral observability events', () => {
    const deferred = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-switch-deferral',
        data: {
          type: 'connected-service-account-switch-deferral',
          policy: 'defer_until_turn_boundary',
          awaitingBoundary: true,
          timeoutMs: 60_000,
        },
      },
    });
    expect(deferred.success).toBe(true);

    const completed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-switch-deferral-completed',
        data: {
          type: 'connected-service-account-switch-deferral-completed',
          policy: 'defer_until_turn_boundary',
          reason: 'completed_at_boundary',
        },
      },
    });
    expect(completed.success).toBe(true);
  });

  it('parses runtime config outcome observability events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-runtime-config-outcome',
        data: {
          type: 'runtime-config-outcome',
          provider: 'claude',
          runtime: 'claude-unified-terminal',
          status: 'requires_restart',
          reason: 'unified_terminal_launch_options_changed',
          message: 'Claude unified terminal is already running. Model changes apply when Claude restarts.',
          changes: [
            { key: 'model', requested: 'claude-opus-4-7', previous: 'claude-opus-4-6' },
            { key: 'reasoningEffort', requested: 'max', previous: 'low' },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.content.type === 'event') {
      expect(parsed.data.content.data).toMatchObject({
        type: 'runtime-config-outcome',
        status: 'requires_restart',
        changes: [
          { key: 'model' },
          { key: 'reasoningEffort' },
        ],
      });
    }
  });

  it('parses paused continuation metadata for completed context compaction records', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-compact-paused',
        data: {
          type: 'context-compaction',
          phase: 'completed',
          source: 'provider-event',
          continuation: 'paused',
          pauseReason: 'provider-idle-after-compaction',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.content.type === 'event') {
      expect(parsed.data.content.data).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      });
    }
  });

  it('rejects invalid context compaction continuation metadata', () => {
    const invalidEvents = [
      {
        id: 'event-compact-invalid-continuation',
        data: {
          continuation: 'stopped',
          pauseReason: 'provider-idle-after-compaction',
        },
      },
      {
        id: 'event-compact-invalid-pause-reason',
        data: {
          continuation: 'paused',
          pauseReason: 'provider-timeout',
        },
      },
      {
        id: 'event-compact-paused-non-completed-phase',
        data: {
          phase: 'failed',
          continuation: 'paused',
          pauseReason: 'provider-idle-after-compaction',
        },
      },
      {
        id: 'event-compact-pause-reason-without-continuation',
        data: {
          pauseReason: 'provider-idle-after-compaction',
        },
      },
    ];

    for (const event of invalidEvents) {
      const parsed = TranscriptRawRecordV1Schema.safeParse({
        role: 'agent',
        content: {
          type: 'event',
          id: event.id,
          data: {
            type: 'context-compaction',
            phase: 'completed',
            ...event.data,
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
      pauseReason: 'provider-idle-after-compaction',
    }).success).toBe(false);
  });

  it('normalizes legacy detected context compaction phase to completed', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-compact-detected',
        data: {
          type: 'context-compaction',
          phase: 'detected',
          source: 'transcript-inference',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.content.type === 'event') {
      expect(parsed.data.content.data).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        source: 'transcript-inference',
      });
    }
  });

  it('parses connected-service account switch events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch',
        data: {
          type: 'connected-service-account-switch',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          groupLabel: 'Codex pool',
          fromProfileId: 'work',
          toProfileId: 'backup',
          fromProfileLabel: 'Work account',
          toProfileLabel: 'Backup account',
          reason: 'usage_limit',
          mode: 'hot_apply',
          resetAtMs: 1_000,
          effectiveRemainingPct: 12,
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.content.type === 'event'
      ? parsed.data.content.data
      : null).toMatchObject({
      type: 'connected-service-account-switch',
      groupLabel: 'Codex pool',
      fromProfileLabel: 'Work account',
      toProfileLabel: 'Backup account',
    });
  });

  it('parses connected-service account switch events with native endpoints', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch-native-to-connected',
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

  it('parses connected-service account switch attempt events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch-attempt',
        data: {
          type: 'connected-service-account-switch-attempt',
          ok: false,
          action: 'restart_requested',
          errorCode: 'post_switch_recovery_failed',
          partialState: 'runtime_auth_applied',
        },
      },
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

  it('preserves exact shared-auth-surface switch attempt verification details', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch-attempt-shared-surface-verification',
        data: {
          type: 'connected-service-account-switch-attempt',
          ok: true,
          action: 'hot_applied',
          verificationByServiceId: {
            'claude-subscription': {
              status: 'verified',
              sharedAuthSurfaceId: 'claude-team',
              proofStrength: 'exact',
              source: 'runtime_identity_probe',
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
      'claude-subscription': {
        status: 'verified',
        sharedAuthSurfaceId: 'claude-team',
        proofStrength: 'exact',
        source: 'runtime_identity_probe',
      },
    });
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

  it('parses connected-service switch attempts through raw records with explicit outcome semantics', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-account-switch-attempt-hot-apply-failed',
        data: {
          type: 'connected-service-account-switch-attempt',
          ok: false,
          action: 'hot_applied',
          attemptedContinuityMode: 'hot_apply',
          outcome: 'failed',
          outcomeAction: 'none',
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
    expect(content.data.outcome).toBe('failed');
    expect(content.data.outcomeAction).toBe('none');
  });

  it('parses connected-service switch attempts with explicit successful hot-apply outcome semantics', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      type: 'connected-service-account-switch-attempt',
      ok: true,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'succeeded',
      outcomeAction: 'hot_applied',
    });

    expect(parsed.success).toBe(true);
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

    expect(attemptedHotApplyWithoutOutcome.success).toBe(false);
    expect(diagnosticWithoutOutcome.success).toBe(false);
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

  it('parses provider state-sharing degraded events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-provider-state-sharing-degraded',
        data: {
          type: 'provider-state-sharing-degraded',
          serviceId: 'anthropic',
          requestedStateMode: 'shared',
          effectiveStateMode: 'isolated',
          code: 'state_symlink_unavailable',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('strips legacy provider state-sharing entry names from parsed events', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-provider-state-sharing-degraded',
        data: {
          type: 'provider-state-sharing-degraded',
          serviceId: 'openai-codex',
          requestedStateMode: 'shared',
          effectiveStateMode: 'isolated',
          code: 'state_symlink_unavailable',
          entryName: 'sessions/--Users-alice-work-project--',
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect(JSON.stringify(parsed.data)).not.toContain('Users-alice-work-project');
    expect(JSON.stringify(parsed.data)).not.toContain('entryName');
  });

  it('parses provider quota wait and recovered events', () => {
    const wait = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-quota-wait',
        data: {
          type: 'provider-quota-wait',
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: 'codex-main',
          resetAtMs: 1_000,
          reason: 'usage_limit',
        },
      },
    });
    const recovered = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        id: 'event-quota-recovered',
        data: {
          type: 'provider-quota-recovered',
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: 'codex-main',
          reason: 'reset_confirmed',
        },
      },
    });

    expect(wait.success).toBe(true);
    expect(recovered.success).toBe(true);
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

describe('runtime-config-outcome timing and sessionMode contract', () => {
  const baseEvent = {
    type: 'runtime-config-outcome' as const,
    provider: 'claude',
    runtime: 'claude-unified-terminal',
    status: 'applied' as const,
    message: 'Runtime config outcome.',
  };

  it('exposes the frozen public status, timing, and change-key type members', () => {
    const statuses: RuntimeConfigOutcomeStatusV1[] = [
      'applied',
      'requires_restart',
      'requires_interactive_control',
      'unsupported',
      'failed',
    ];
    const timings: RuntimeConfigOutcomeTimingV1[] = [
      'current_window',
      'queued_until_safe_window',
      'scheduled_for_next_prompt',
      'next_idle',
      'before_next_prompt',
      'skipped_already_effective',
      'not_applicable',
    ];
    const changeKeys: RuntimeConfigOutcomeChangeKeyV1[] = [
      'model',
      'fallbackModel',
      'permissionMode',
      'reasoningEffort',
      'maxThinkingTokens',
      'launchOption',
      'sessionMode',
    ];

    expect(statuses).toHaveLength(5);
    expect(timings).toHaveLength(7);
    expect(changeKeys).toContain('sessionMode');
  });

  it('round-trips an optional timing field when present and accepts it when absent', () => {
    const withTiming = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      message: 'Model scheduled for the next prompt.',
      timing: 'scheduled_for_next_prompt',
    });
    expect(withTiming.success).toBe(true);
    if (!withTiming.success) throw new Error('expected parse success');
    expect(withTiming.data).toMatchObject({ timing: 'scheduled_for_next_prompt' });

    const withoutTiming = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      message: 'Model applied in the current window.',
    });
    expect(withoutTiming.success).toBe(true);
    if (!withoutTiming.success) throw new Error('expected parse success');
    expect((withoutTiming.data as Record<string, unknown>).timing).toBeUndefined();
  });

  it('accepts every public timing value and rejects unknown timing values', () => {
    const validTimings: RuntimeConfigOutcomeTimingV1[] = [
      'current_window',
      'queued_until_safe_window',
      'scheduled_for_next_prompt',
      'next_idle',
      'before_next_prompt',
      'skipped_already_effective',
      'not_applicable',
    ];

    for (const timing of validTimings) {
      const parsed = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, timing });
      expect(parsed.success).toBe(true);
    }

    const unknownTiming = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      timing: 'eventually_maybe',
    });
    expect(unknownTiming.success).toBe(false);
  });

  it('passes through unknown top-level keys on runtime-config-outcome events (back-compat property)', () => {
    // The event object is `.passthrough()`, so clients running an older schema strip
    // unknown top-level keys instead of rejecting the event. This is exactly what makes
    // adding the new optional top-level `timing` field forward/back-compatible.
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      message: 'Forward-compatible top-level field.',
      someFutureTopLevelField: { nested: true },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect((parsed.data as Record<string, unknown>).someFutureTopLevelField).toEqual({ nested: true });
  });

  it('accepts a sessionMode change key', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      message: 'Session mode updated.',
      timing: 'current_window',
      changes: [{ key: 'sessionMode', requested: 'plan', previous: 'default' }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected parse success');
    expect(parsed.data).toMatchObject({
      changes: [{ key: 'sessionMode', requested: 'plan', previous: 'default' }],
    });
  });

  it('keeps the five public statuses frozen and rejects timing-shaped status values', () => {
    const applied = TranscriptRawAgentEventV1Schema.safeParse({ ...baseEvent, status: 'applied' });
    expect(applied.success).toBe(true);

    // A timing value must never leak into the status enum.
    const queuedStatus = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      status: 'queued_until_safe_window',
    });
    expect(queuedStatus.success).toBe(false);
  });

  it('rejects unknown change keys (changes are strict)', () => {
    const parsed = TranscriptRawAgentEventV1Schema.safeParse({
      ...baseEvent,
      changes: [{ key: 'sessionGoal', requested: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * `attentionImpact` is not a persisted column, so every read re-derives attention
 * from stored content. This owner is therefore the single attention decision for
 * the transition divider; both re-read resolvers inherit it by delegating here.
 */
describe('agent-transition divider attention', () => {
  const divider = {
    type: 'message',
    message: 'Continued with another Agent.',
    sessionAgentTransitionV1: { v: 1, fromAgentId: 'claude', toAgentId: 'codex' },
  };

  it('silences an event carrying the transition sidecar', () => {
    expect(agentEventAttentionImpact(divider)).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
  });

  it('leaves an ordinary passthrough message event attention-bearing', () => {
    expect(agentEventAttentionImpact({ type: 'message', message: 'Continued with another Agent.' })).toEqual({
      affectsUnread: true,
      affectsMeaningfulActivity: true,
    });
  });

  it('does not silence a malformed or unknown-version sidecar', () => {
    for (const sidecar of [{ v: 2, fromAgentId: 'claude', toAgentId: 'codex' }, 'garbage', null]) {
      expect(agentEventAttentionImpact({ type: 'message', message: 'x', sessionAgentTransitionV1: sidecar })).toEqual({
        affectsUnread: true,
        affectsMeaningfulActivity: true,
      });
    }
  });

  /**
   * A malformed sidecar must not make the whole row unparseable. The key name is
   * writable by any client that can post an agent event, and the passthrough
   * `message` arm accepted arbitrary extra keys before this program existed — so
   * a strict nested field that fails the arm would let one write erase a
   * transcript row for every reader.
   */
  it('keeps the transcript row parseable when the sidecar is malformed', () => {
    const parseEventRow = (data: unknown) => TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: { type: 'event', id: 'evt-1', data },
    });

    // Control: the same row shape with a well-formed sidecar parses.
    expect(parseEventRow(divider).success).toBe(true);

    for (const sidecar of [{ v: 2 }, 'garbage', 42]) {
      expect(
        parseEventRow({ type: 'message', message: 'hi', sessionAgentTransitionV1: sidecar }).success,
      ).toBe(true);
    }
  });
});
