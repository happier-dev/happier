import { describe, expect, it } from 'vitest';

import { asStatusErrorMessage } from '@/testkit/backends/transport';
import { DefaultTransport } from './DefaultTransport';

describe('DefaultTransport handleStderr', () => {
  it('emits actionable auth errors', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('401 Unauthorized: missing API key', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Authentication error');
  });

  it('emits actionable model-not-found errors (including ProviderModelNotFoundError)', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('ProviderModelNotFoundError: ProviderModelNotFoundError', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Model not found');
  });

  it('emits status:error for stack-trace style errors', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('Error: something went wrong\n    at fn (file.ts:1:1)', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('something went wrong');
  });

  it('does not misclassify generic "API keys" guidance as an auth error', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('Do not include any sensitive information such as API keys, passwords, credentials.', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(result.message).toBeNull();
  });

  it('does not misclassify non-error "authentication" text as an auth error', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('Authentication with State Persistence', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(result.message).toBeNull();
  });

  it('does not emit status errors for benign stderr output', () => {
    const transport = new DefaultTransport('generic');
    expect(
      transport.handleStderr('INFO 2026-02-26 service=foo msg=starting', {
        activeToolCalls: new Set(),
        hasActiveInvestigation: false,
      }).message,
    ).toBeNull();
  });
});
