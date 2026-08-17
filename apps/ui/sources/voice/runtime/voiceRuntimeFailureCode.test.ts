import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSafeVoiceRuntimeFailureDiagnosticReason,
  recordVoiceRuntimeFailure,
} from './voiceRuntimeFailureCode';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy } }));

describe('voiceRuntimeFailureCode', () => {
  beforeEach(() => {
    logSpy.mockClear();
  });

  it('distinguishes bounded metadata commit reasons without retaining arbitrary error data', () => {
    const refreshFailure = Object.assign(
      new Error('private refresh failure for /Users/example/secret'),
      {
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        reason: 'session_refresh_failed',
        cause: { authorization: 'Bearer private-token' },
      },
    );
    const writeFailure = Object.assign(
      new Error('private metadata response body'),
      {
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        reason: 'metadata_write_rejected',
        cause: { providerPayload: 'private-provider-payload' },
      },
    );

    for (const error of [refreshFailure, writeFailure]) {
      recordVoiceRuntimeFailure(
        'realtime_codex',
        'failed',
        'connection_failed',
        error.code,
        readSafeVoiceRuntimeFailureDiagnosticReason(error),
      );
    }

    const records = logSpy.mock.calls.map(([line]) => String(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('"diagnosticReason":"session_refresh_failed"');
    expect(records[1]).toContain('"diagnosticReason":"metadata_write_rejected"');
    expect(records.join('\n')).not.toMatch(
      /private refresh failure|\/Users\/example\/secret|Bearer private-token|private metadata response body|private-provider-payload/,
    );
  });

  it.each([
    undefined,
    'unrecognized_private_reason',
    { nested: 'session_refresh_failed' },
  ])('uses unknown for an absent or unrecognized structural reason', (reason) => {
    expect(readSafeVoiceRuntimeFailureDiagnosticReason({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      reason,
    })).toBe('unknown');
  });

  it('does not accept a metadata reason from another error family', () => {
    expect(readSafeVoiceRuntimeFailureDiagnosticReason({
      code: 'ANOTHER_FAILURE',
      reason: 'session_refresh_failed',
    })).toBeUndefined();
  });

  it('normalizes an arbitrary recorder input without serializing it', () => {
    recordVoiceRuntimeFailure(
      'realtime_codex',
      'failed',
      'connection_failed',
      'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      { privateReason: 'provider-secret-detail' },
    );

    const record = String(logSpy.mock.calls[0]?.[0]);
    expect(record).toContain('"diagnosticReason":"unknown"');
    expect(record).not.toContain('provider-secret-detail');
  });
});
