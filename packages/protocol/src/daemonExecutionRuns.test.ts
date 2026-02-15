import { describe, expect, it } from 'vitest';

import { DaemonExecutionRunMarkerSchema } from './daemonExecutionRuns.js';

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
      backendId: 'codex',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'vendor_session.v1',
        backendId: 'codex',
        // vendorSessionId missing on purpose
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
      backendId: 'codex',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'succeeded',
      startedAtMs: 0,
      updatedAtMs: 1,
      resumeHandle: {
        kind: 'vendor_session.v1',
        backendId: 'codex',
        vendorSessionId: 'vendor-session-123',
      },
    });

    expect(parsed.success).toBe(true);
  });
});
