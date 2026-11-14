import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { describe, expect, it } from 'vitest';
import { classifyPrimarySessionRuntimeIssue } from './classifyPrimarySessionRuntimeIssue';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import { withRetry } from '@/agent/acp/withRetry';
import { readNativeStartupFailureDetail } from './nativeStartupFailureDetail';
import { createRuntimeFailureTranscriptProjector } from '../transcripts/runtimeFailureTranscript';

describe('native startup failure cause retention', () => {
  it.each(['client_start', 'turn_start'] as const)('retains Provider launch causes at the known %s boundary', phase => {
    const failureCause = { phase: 'dispatch', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503 } as const;
    const error = Object.assign(new Error('PRIVATE_PROVIDER_BODY'), createProviderErrorV1('provider_materialization_failed', { failureCause }));
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: phase, error });
    expect(issue.failureCause).toMatchObject({ phase, code: error.code, providerErrorCode: 'ECONNRESET', httpStatus: 503 });
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_PROVIDER_BODY');
  });

  it.each(['provider_materialization_failed', 'provider_endpoint_unavailable'] as const)(
    'keeps unstructured prose private for the typed Provider startup refusal %s', code => {
      const error = Object.assign(new Error('PRIVATE_PROVIDER_BODY'), createProviderErrorV1(code));
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error, occurredAt: 100 });
      expect(issue.code).toBe(code);
      expect(JSON.stringify(issue)).not.toContain('PRIVATE_PROVIDER_BODY');
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100, error: {
        code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause },
      } })).toEqual(issue);
    },
  );

  it.each([['root', false], ['root', true], ['details', false], ['details', true]] as const)(
    'redacts a typed %s cause while dropping unrelated native context (forced=%s)', (envelope, forceSafeShape) => {
    const failureCause = { code: 'resource_unavailable', phase: 'authentication', failureReason: 'unknown',
      providerErrorMessage: 'Broker refused api_key=synthetic-private-token' };
    const native = Object.assign(new Error('Startup failed'), envelope === 'root' ? { failureCause, raw: 'PRIVATE_CONTEXT' }
      : { details: { failureCause }, raw: 'PRIVATE_CONTEXT' });
    const error = sanitizeNativeAgentSessionBoundaryError(native, forceSafeShape);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause).toMatchObject({ code: 'resource_unavailable', phase: 'authentication',
      providerErrorMessage: redactBugReportSensitiveText(failureCause.providerErrorMessage) });
    expect(JSON.stringify(error)).not.toMatch(/synthetic-private-token|PRIVATE_CONTEXT/);
    const malformed = Object.assign(new Error('Startup failed'), { failureCause: { ...failureCause, raw: 'PRIVATE_CONTEXT' } });
    expect(sanitizeNativeAgentSessionBoundaryError(malformed, true)).not.toHaveProperty('failureCause');
  });
  it.each(['resource_unavailable', 'resource_forbidden', 'broker_unavailable'] as const)(
    'retains the typed Team broker %s refusal through the native privacy boundary', code => {
      const original = new SessionTeamCredentialLaunchUnavailableError(code, 'readiness');
      const error = sanitizeNativeAgentSessionBoundaryError(original, true);
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
      expect(issue.failureCause).toMatchObject({ code, phase: 'authentication', failureReason: 'unknown' });
      expect(issue.failureCause?.failureReason).not.toBe('unclassified_provider_error');
    });
  it('enriches an existing unclassified startup cause without losing its native evidence', () => {
    const error = Object.assign(new Error('Native open refused'), { code: -32603,
      details: { failureCause: { phase: 'client_start', failureReason: 'unclassified_provider_error' } } });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause).toMatchObject({ providerErrorCode: -32603, providerErrorMessage: 'Native open refused' });
  });
  it('retains native details through the generic host privacy boundary', () => {
    const native = { code: -32603, message: 'Native session refused token=synthetic-private-token', data: { prompt: 'PRIVATE_PROMPT' } };
    const error = sanitizeNativeAgentSessionBoundaryError(native, true);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause).toMatchObject({ providerErrorCode: -32603, providerErrorMessage: redactBugReportSensitiveText(native.message) });
    expect(JSON.stringify(issue)).not.toMatch(/synthetic-private-token|PRIVATE_PROMPT/);
  });
  it('retains a real JSON-RPC rejection through ACP retry normalization and publication', async () => {
    const native = { code: -32603, message: 'Native initialization refused token=synthetic-private-token',
      data: { prompt: 'PRIVATE_PROMPT', stderr: 'PRIVATE_STDERR' } };
    let error: unknown;
    try { await withRetry(async () => { throw native; }, { operationName: 'Initialize', maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }); }
    catch (caught) { error = caught; }
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause).toMatchObject({ phase: 'client_start', providerErrorCode: -32603,
      providerErrorMessage: redactBugReportSensitiveText(native.message) });
    expect(JSON.stringify(issue)).not.toMatch(/synthetic-private-token|PRIVATE_PROMPT|PRIVATE_STDERR/);
    const replay = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause } } });
    expect(replay.failureCause).toEqual(issue.failureCause);
  });

  it('retains a native string rejection without serializing surrounding context', async () => {
    let error: unknown;
    try { await withRetry(async () => { throw 'Native request refused token=synthetic-private-token'; },
      { operationName: 'Initialize', maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }); }
    catch (caught) { error = caught; }
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause?.providerErrorMessage).toContain('Native request refused');
    expect(JSON.stringify(issue)).not.toContain('synthetic-private-token');
  });

  it('retains native Error codes and only the first redacted message line', () => {
    const native = Object.assign(new Error('Native launch refused api_key=synthetic-private-token\nPRIVATE_STDERR'), { code: 'EACCES' });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start',
      error: new Error('Host wrapper', { cause: native }) });
    expect(issue.failureCause).toMatchObject({ providerErrorCode: 'EACCES', providerErrorMessage: redactBugReportSensitiveText(native.message.split('\n')[0]!) });
    expect(JSON.stringify(issue)).not.toMatch(/synthetic-private-token|PRIVATE_STDERR/);
    const replay = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: {
      code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause } } });
    expect(replay.failureCause).toEqual(issue.failureCause);
  });
  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('omits native multiline context after the first line (%j)', separator => {
    const firstLine = 'Native startup refused api_key=synthetic-private-token';
    const message = `${firstLine}${separator}PRIVATE_STDERR`;
    const native = Object.assign(new Error(message), { code: 'EACCES' });
    const error = sanitizeNativeAgentSessionBoundaryError(new Error('Host wrapper', { cause: native }), true);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause).toMatchObject({ providerErrorCode: 'EACCES',
      providerErrorMessage: redactBugReportSensitiveText(firstLine) });
    expect(readNativeStartupFailureDetail(message).providerErrorMessage).toBe(redactBugReportSensitiveText(firstLine));
    expect(JSON.stringify({ issue, detail: readNativeStartupFailureDetail(native) })).not.toMatch(/PRIVATE_STDERR|synthetic-private-token/);
  });

  it('does not promote private context after an empty native message line', () => {
    expect(readNativeStartupFailureDetail('\nPRIVATE_STDERR').providerErrorMessage).toBeUndefined();
  });

  it.each([false, true])('does not promote stderr after a blank public line through native sanitization and history (forced=%s)', async forceSafeShape => {
    const native = Object.assign(new Error(' \nPRIVATE_STDERR'), { code: 'EACCES' });
    const error = sanitizeNativeAgentSessionBoundaryError(native, forceSafeShape);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    const stored: unknown[] = [];
    const project = createRuntimeFailureTranscriptProjector({ provider: 'codex', providerName: 'Codex', session: {
      sessionId: 'native-privacy', enqueueAgentMessageCommitted: async (provider, body, options) => {
        stored.push({ provider, body, meta: options.meta });
        return { persisted: true, delivered: true, committedSequence: 1 };
      },
    } });
    await project({ kind: 'turn-failed', sessionId: 'native-privacy', turnId: 'startup', sequence: 1,
      emittedAtMs: 1, diagnostic: { code: issue.code, severity: 'error' } }, { issue });
    expect(issue.failureCause?.providerErrorCode).toBe('EACCES');
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify({ issue, stored })).not.toContain('PRIVATE_STDERR');
  });

  it.each([false, true])('does not promote a private native code after a blank line (forced=%s)', forceSafeShape => {
    const native = Object.assign(new Error('Native startup refused'), { code: ' \nPRIVATE_NATIVE_CODE' });
    const error = sanitizeNativeAgentSessionBoundaryError(native, forceSafeShape);
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
    expect(issue.failureCause?.providerErrorMessage).toBe('Native startup refused');
    expect(JSON.stringify({ error, issue })).not.toContain('PRIVATE_NATIVE_CODE');
  });

  it.each([' \nPRIVATE_STDERR', { message: ' \nPRIVATE_STDERR', code: 'EACCES' }])(
    'does not promote a blank native public line from a non-Error rejection (%j)', native => {
      const error = sanitizeNativeAgentSessionBoundaryError(native, true);
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error });
      expect(JSON.stringify({ error, issue })).not.toContain('PRIVATE_STDERR');
    });

  it.each([
    ['Authentication required', 'authentication_required'],
    ['The selected model is unavailable in the native catalog', 'model_selection_required'],
  ] as const)('refines %s without replacing the native causal evidence', (message, failureReason) => {
    const failureCause = { phase: 'thread_open' as const, failureReason: 'unclassified_provider_error' as const,
      providerErrorCode: -32000, providerErrorMessage: 'Native refusal token=synthetic-private-token' };
    const error = Object.assign(new Error(message), { details: { failureCause } });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', startupPhase: 'client_start', error, occurredAt: 100 });
    expect(issue.failureCause).toMatchObject({ ...failureCause, failureReason,
      providerErrorMessage: redactBugReportSensitiveText(failureCause.providerErrorMessage) });
    expect(JSON.stringify(issue)).not.toContain('synthetic-private-token');
    const replay = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100, error: {
      code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause } } });
    expect(replay.failureCause).toEqual(issue.failureCause);
  });

});
