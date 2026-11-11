import { describe, expect, it } from 'vitest';
import { classifyPrimarySessionRuntimeIssue } from './classifyPrimarySessionRuntimeIssue';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { withRetry } from '@/agent/acp/withRetry';

describe('native startup failure cause retention', () => {
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
});
