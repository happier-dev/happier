import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

import { handlePiRpcStderrLine, type PiRpcStderrHandlerContext } from './eventHandlers';

function createContext(overrides?: Partial<PiRpcStderrHandlerContext>): PiRpcStderrHandlerContext {
  return {
    disposed: false,
    currentModelProvider: 'openai',
    ...overrides,
  };
}

describe('handlePiRpcStderrLine', () => {
  it('forwards auth-looking stderr as terminal output without terminalizing the turn', () => {
    const emitMessage = vi.fn();

    handlePiRpcStderrLine(createContext(), emitMessage, 'authentication state refreshed for pi');

    expect(emitMessage).toHaveBeenCalledWith({
      type: 'terminal-output',
      data: 'authentication state refreshed for pi',
    });
    expect(emitMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'status',
      status: 'error',
    }));
  });

  it('reports usage-limit stderr through runtime-auth classification without terminalizing the turn', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const emitMessage = vi.fn();
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure: vi.fn(() => classification),
      reportRuntimeAuthFailureForPendingTurn,
    }), emitMessage, 'ERROR: usage limit reached for this account (resource_exhausted)');

    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
    expect(emitMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'status',
      status: 'error',
    }));
  });

  it('normalizes machine-readable usage-limit stderr before classification', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"type":"usage_limit_reached"}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'usage_limit_reached',
      provider: 'openai',
      message: '{"type":"usage_limit_reached"}',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies structured 429 stderr without rate-limit wording', () => {
    const classification = {
      kind: 'rate_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"status":429}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 429,
      provider: 'openai',
      message: '{"status":429}',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies nested structured 429 stderr without rate-limit wording', () => {
    const classification = {
      kind: 'rate_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"error":{"status":429}}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 429,
      provider: 'openai',
      message: '{"error":{"status":429}}',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies nested structured 429 stderr inside JSON-RPC wrappers', () => {
    const classification = {
      kind: 'rate_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"error":{"code":-32603,"message":"Internal error","data":{"status":429}}}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 429,
      provider: 'openai',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies plain HTTP 429 stderr as numeric status evidence', () => {
    const classification = {
      kind: 'rate_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), 'HTTP 429');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      status: 429,
      provider: 'openai',
      message: 'HTTP 429',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies structured usage-limit marker names without spaces or underscores', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"type":"FreeUsageLimitError"}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'FreeUsageLimitError',
      provider: 'openai',
      message: '{"type":"FreeUsageLimitError"}',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies nested JSON-RPC usage-limit markers', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"code":-32603,"message":"Internal error","data":{"codex_error_info":"usage_limit_exceeded"}}');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'usage_limit_exceeded',
      provider: 'openai',
      message: 'Internal error',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies plain stderr usage-limit marker names as marker evidence', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), 'FreeUsageLimitError');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'FreeUsageLimitError',
      provider: 'openai',
      message: 'FreeUsageLimitError',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledWith(classification);
  });

  it('classifies rate-limit marker names without prose', () => {
    const classification = {
      kind: 'rate_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const classifyRuntimeAuthFailure = vi.fn(() => classification);
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), '{"type":"rate_limit_error"}');
    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), 'RateLimitError');

    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'rate_limit_error',
      provider: 'openai',
      message: '{"type":"rate_limit_error"}',
    }));
    expect(classifyRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'RateLimitError',
      provider: 'openai',
      message: 'RateLimitError',
    }));
    expect(reportRuntimeAuthFailureForPendingTurn).toHaveBeenCalledTimes(2);
  });

  it('does not classify bare quota diagnostics without exhaustion wording', () => {
    const classifyRuntimeAuthFailure = vi.fn();
    const reportRuntimeAuthFailureForPendingTurn = vi.fn(() => true);

    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), 'quota telemetry snapshot refreshed');
    handlePiRpcStderrLine(createContext({
      classifyRuntimeAuthFailure,
      reportRuntimeAuthFailureForPendingTurn,
    }), vi.fn(), 'quota limit: 100000 remaining: 95000');

    expect(classifyRuntimeAuthFailure).not.toHaveBeenCalled();
    expect(reportRuntimeAuthFailureForPendingTurn).not.toHaveBeenCalled();
  });
});
