import { beforeEach, describe, expect, it } from 'vitest';
import { log } from '@/log';

import {
  readSafeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureDiagnosticReason,
  recordVoiceRuntimeFailure,
  readSafeVoiceRuntimeFailureFacts,
} from './voiceRuntimeFailureCode';
import { createVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

describe('voiceRuntimeFailureCode', () => {
  beforeEach(() => {
    log.clear();
  });

  it.each([429, 503])('records producer cause facts for HTTP %s without provider content', status => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new TypeError('private provider payload'), { status }), 'voice.preflight');
    recordVoiceRuntimeFailure('realtime_codex', 'declined', 'provider_error', 'provider_unavailable', undefined, undefined, failureCause);
    expect(log.getLogs()[0]).toContain(JSON.stringify(failureCause));
    expect(log.getLogs()[0]).not.toContain('private provider payload');
  });

  it.each(['capture', 'machine'] as const)('reads an existing cause through the %s error carrier', carrier => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new TypeError('private capture response'), { status: 503 }), 'voice.capture');
    const original = Object.assign(new Error('private response'), { failureCause });
    const error = carrier === 'capture' ? { kind: 'provider_error', reason: 'stt_failed', cause: original }
      : new Error('tts_failed', { cause: original });
    expect(readSafeVoiceRuntimeFailureFacts(error)).toMatchObject({ failureCause });
  });

  it.each([
    { name: 'HTTP TypeError', error: Object.assign(new TypeError('Bearer private-response'), { status: 429 }),
      expected: { errorClass: 'TypeError', errorCode: null, httpStatus: 429 } },
    { name: 'filesystem refusal', error: Object.assign(new Error('private path /secret'), { code: 'EACCES' }),
      expected: { errorClass: 'Error', errorCode: 'EACCES', httpStatus: null } },
    { name: 'private exception code', error: Object.assign(new Error('private provider prose'), { code: 'PRIVATE_CUSTOM_CODE' }),
      expected: { errorClass: 'Error', errorCode: null, httpStatus: null } },
  ])('projects safe native facts from a raw $name', ({ error, expected }) => {
    const facts = readSafeVoiceRuntimeFailureFacts(error);
    expect(facts).toEqual({ failureCause: { phase: 'voice.runtime', ...expected } });
    expect(JSON.stringify(facts)).not.toMatch(/private|Bearer|secret|PRIVATE_CUSTOM_CODE/);
    expect(readSafeVoiceRuntimeFailureFacts({ status: 429 })).toEqual({});
  });

  it.each(['agent_signed_out', 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED'])(
    'preserves the acquisition failure %s beneath definite pre-effect rejection', (code) => {
      const cause = Object.assign(new Error('private acquisition details'), { code });
      const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');

      expect(rejection).toMatchObject({
        code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
        pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        cause,
      });
      expect(cause.code).toBe(code);
      expect(readSafeVoiceRuntimeFailureCode(rejection)).toBe(code);
    },
  );

  it('does not disclose arbitrary acquisition prose or unwrap an unrelated error family', () => {
    const cause = new Error('Bearer private-token for /Users/example/secret');
    const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');
    expect(readSafeVoiceRuntimeFailureCode(rejection)).toBe('VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT');
    expect(readSafeVoiceRuntimeFailureCode(Object.assign(new Error('outer'), {
      code: 'another_error', cause: { code: 'agent_signed_out' },
    }))).toBe('another_error');
  });

  it('preserves cancellation identity for the existing Local Voice abort handler', () => {
    const cause = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');
    expect(rejection.name).toBe('AbortError');
    expect(rejection.cause).toBe(cause);
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

    const records = log.getLogs();
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

    const record = log.getLogs()[0];
    expect(record).toContain('"diagnosticReason":"unknown"');
    expect(record).not.toContain('provider-secret-detail');
  });
});
