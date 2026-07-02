import { describe, expect, it } from 'vitest';

import {
  DaemonExecutionRunListResponseSchema,
  DaemonExecutionRunMarkerSchema,
} from './daemonExecutionRuns.js';

describe('DaemonExecutionRunMarkerSchema', () => {
  it('rejects invalid resumeHandle shapes', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        // providerSessionId missing on purpose
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a valid resumeHandle', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('reads legacy backend target fields in list responses and preserves additive transport fields', () => {
    const parsed = DaemonExecutionRunListResponseSchema.parse({
      runs: [
        {
          happyHomeDir: '/tmp/happy',
          pid: 123,
          happySessionId: 'session_1',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          intent: 'plan',
          backendId: 'codex',
          runClass: 'bounded',
          ioMode: 'request_response',
          retentionPolicy: 'resumable',
          status: 'succeeded',
          startedAtMs: 0,
          updatedAtMs: 1,
          extraTransportField: 'keep-me',
        },
      ],
    });

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
    expect((parsed.runs[0] as any).extraTransportField).toBe('keep-me');
  });

  it('accepts legacy backendId fields in markers and resume handles', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'codex',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendId: 'codex',
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data.backendTarget).toEqual({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
    expect(parsed.data.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      providerSessionId: 'vendor-session-123',
    });
  });

  it('accepts legacy configured backend provenance in markers and resume handles', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
        providerSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
    expect(parsed.data.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      providerSessionId: 'vendor-session-123',
    });
  });

  it('accepts canonical V2 backendTarget input in markers and list responses', () => {
    const markerParsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(markerParsed.success).toBe(true);
    if (!markerParsed.success) {
      throw markerParsed.error;
    }
    expect(markerParsed.data.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });

    const listParsed = DaemonExecutionRunListResponseSchema.parse({
      runs: [
        {
          happyHomeDir: '/tmp/happy',
          pid: 123,
          happySessionId: 'session_1',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          intent: 'plan',
          backendTarget: {
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
            sourceKind: 'configured',
          },
          runClass: 'bounded',
          ioMode: 'request_response',
          retentionPolicy: 'resumable',
          status: 'succeeded',
          startedAtMs: 0,
          updatedAtMs: 1,
        },
      ],
    });

    expect(listParsed.runs[0]?.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('rejects ambiguous customAcp legacy backendId fields in markers', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'customAcp',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects legacy configured ACP flavor carriers in marker backend ids', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendId: 'acp:review-bot',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects marker entries that use builtIn customAcp as a concrete backend target', () => {
    const parsed = DaemonExecutionRunMarkerSchema.safeParse({
      happyHomeDir: '/tmp/happy',
      pid: 123,
      happySessionId: 'session_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
    });

    expect(parsed.success).toBe(false);
  });
});
