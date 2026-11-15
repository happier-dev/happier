import { describe, expect, it } from 'vitest';

import {
  buildPiProviderFailureLogEvidence,
  readPiProviderFailureDiagnostic,
  readPiPromptRejectionDiagnostic,
} from './providerFailureDiagnostic';

describe('readPiProviderFailureDiagnostic', () => {
  // A4 r1115f retained invalid_api_key without an HTTP status. Credential fully redacted.
  it.each([
    { message: '[REDACTED]', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
    { error: { code: 'invalid_api_key', type: 'invalid_request_error', param: null,
      message: 'Incorrect API key provided: [REDACTED].' } },
    { type: 'error', code: 'invalid_api_key', param: null, message: 'Request rejected' },
  ])('projects OpenAI credential refusals without relying on status or prose', (body) => {
    const errorMessage = JSON.stringify(body);
    expect(readPiProviderFailureDiagnostic({ type: 'message_end', message: {
      role: 'assistant', provider: 'openai', model: 'gpt-4.1-nano',
      stopReason: 'error', errorMessage,
    } })).toMatchObject({ code: 'invalid_api_key', piRetryable: false,
      failureCause: { phase: 'authentication', failureReason: 'authentication_required',
        providerErrorCode: 'invalid_api_key' } });
    expect(readPiPromptRejectionDiagnostic(errorMessage)?.failureCause).toMatchObject({
      failureReason: 'authentication_required', providerErrorCode: 'invalid_api_key',
    });
  });

  it.each(['API_KEY_INVALID', 'INVALID_ARGUMENT'])('decodes the Google SDK HTTP 400 wrapper with reason %s', (reason) => {
    // Native row 31: error.message is the JSON body inside the SDK's HTTP envelope.
    const errorMessage = JSON.stringify({ error: { message: JSON.stringify({ error: {
      code: 400, message: '[REDACTED]', status: 'INVALID_ARGUMENT', details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason,
          domain: '[REDACTED]', metadata: { service: '[REDACTED]' } },
        { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: '[REDACTED]' },
      ],
    } }), code: 400, status: 'Bad Request' } });
    const diagnostic = readPiProviderFailureDiagnostic({ type: 'message_end', message: {
      role: 'assistant', provider: 'google', model: 'gemini-2.5-flash', stopReason: 'error', errorMessage,
    } });
    expect(diagnostic?.failureCause).toMatchObject(reason === 'API_KEY_INVALID'
      ? { phase: 'authentication', failureReason: 'authentication_required', providerErrorCode: reason, httpStatus: 400 }
      : { failureReason: 'unknown', httpStatus: 400 });
  });

  it('does not classify unrelated OpenAI request errors as authentication', () => {
    expect(readPiProviderFailureDiagnostic({ type: 'message_end', message: {
      role: 'assistant', stopReason: 'error', errorMessage: JSON.stringify({ error: {
        code: 'invalid_request_error', type: 'invalid_request_error', message: 'Request rejected',
      } }),
    } })?.failureCause).toMatchObject({ failureReason: 'unknown' });
  });

  it.each([401, 403])('CC6 projects a code-less HTTP %s through the shared cause owner', (status) => {
    const record = { type: 'turn_failed', errorMessage: `${status} Provider refused the request` };
    expect(readPiProviderFailureDiagnostic(record)).toMatchObject({
      failureCause: { failureReason: 'authentication_required', httpStatus: status },
    });
    expect(readPiPromptRejectionDiagnostic(record.errorMessage)).toMatchObject({
      failureCause: { failureReason: 'authentication_required', httpStatus: status },
    });
  });
  it('preserves and classifies provider timeouts as retryable', () => {
    expect(readPiProviderFailureDiagnostic({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'meta',
        model: 'muse-spark-1.3-contributor',
        stopReason: 'error',
        errorMessage: 'Request timed out.',
      },
    })).toEqual({
      classification: 'pi_provider_failure',
      code: 'provider_timeout',
      sanitizedPreview: 'Request timed out.',
      piRetryable: true,
      failureCause: expect.objectContaining({ phase: 'turn', failureReason: 'unknown' }),
    });
  });

  it('preserves safe structured fields from a Pi turn_failed record without an assistant message', () => {
    expect(readPiProviderFailureDiagnostic({
      type: 'turn_failed',
      code: 'rate_limit_exceeded',
      status: 429,
      detail: 'Service temporarily unavailable. Please retry.',
    })).toEqual({
      classification: 'pi_provider_failure',
      code: 'rate_limit_exceeded',
      sanitizedPreview: 'Service temporarily unavailable. Please retry.',
      piRetryable: true,
      failureCause: expect.objectContaining({ phase: 'turn', failureReason: 'unknown', httpStatus: 429 }),
    });
  });

  it.each([
    ['happier_broker_bridge_status_500', true],
    ['happier_broker_bridge_status_401', false],
  ] as const)('classifies internal Connected Service broker status %s with retryable=%s', (
    brokerStatus,
    piRetryable,
  ) => {
    expect(readPiProviderFailureDiagnostic({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        stopReason: 'error',
        errorMessage: `OAuth refresh failed for openai-codex: ${brokerStatus}`,
      },
    })).toMatchObject({ piRetryable });
  });

  it('redacts secrets in nested Pi turn_failed diagnostics', () => {
    const diagnostic = readPiProviderFailureDiagnostic({
      type: 'turn_failed',
      error: {
        code: 'provider_auth_failed',
        message: 'Credential sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was rejected',
      },
    });

    expect(diagnostic).toEqual({
      classification: 'pi_provider_failure',
      code: 'provider_auth_failed',
      sanitizedPreview: 'Credential [REDACTED] was rejected',
      piRetryable: false,
      failureCause: expect.objectContaining({ phase: 'turn', failureReason: 'unknown' }),
    });
    expect(JSON.stringify(diagnostic)).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('projects provider/model/status context without logging content or raw error bodies', () => {
    const evidence = buildPiProviderFailureLogEvidence({
      type: 'message_end',
      status: 401,
      secret: 'must not escape',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        stopReason: 'error',
        content: [{ type: 'text', text: 'private prompt' }],
        errorMessage: 'Credential sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa failed',
      },
    });

    expect(evidence).toEqual({
      record: { type: 'message_end', status: 401 },
      messageShape: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        stopReason: 'error',
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('private prompt');
    expect(JSON.stringify(evidence)).not.toContain('sk-proj-');
    expect(JSON.stringify(evidence)).not.toContain('must not escape');
  });

  it('preserves canonical slash-qualified model identifiers in safe log evidence', () => {
    expect(buildPiProviderFailureLogEvidence({
      type: 'message_end',
      provider: 'meta',
      model: 'meta/muse-spark-1.3-contributor',
      message: {
        role: 'assistant',
        provider: 'zai',
        modelId: 'zai/glm-5.3-flash',
        stopReason: 'error',
      },
    })).toEqual({
      record: {
        type: 'message_end',
        provider: 'meta',
        model: 'meta/muse-spark-1.3-contributor',
      },
      messageShape: {
        role: 'assistant',
        provider: 'zai',
        modelId: 'zai/glm-5.3-flash',
        stopReason: 'error',
      },
    });
  });

  it.each([
    '429 {"error":{"code":"rate_limit_error","message":"Too many requests"}}',
    '529 {"error":{"code":"overloaded_error","message":"Provider overloaded"}}',
    'Request timed out.',
  ])('marks an explicit pre-acceptance transient Provider rejection retryable: %s', (message) => {
    expect(readPiPromptRejectionDiagnostic(new Error(message))).toMatchObject({
      classification: 'pi_provider_failure',
      piRetryable: true,
    });
  });

  it('keeps an explicit pre-acceptance authentication rejection non-retryable', () => {
    expect(readPiPromptRejectionDiagnostic(new Error(
      '401 {"error":{"code":"invalid_api_key","message":"Invalid credential"}}',
    ))).toMatchObject({
      classification: 'pi_provider_failure',
      piRetryable: false,
    });
  });
});
