import { describe, expect, it } from 'vitest';

import { asStatusErrorMessage } from '@/testkit/backends/transport';
import { DefaultTransport } from './DefaultTransport';

describe('DefaultTransport handleStderr', () => {
  it.each([
    '401 Unauthorized: missing API key',
    'Error code: 401 - invalid_authentication_error',
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    'Failed to refresh token: 401 Unauthorized: refresh token expired',
    'provider request failed: 401 unauthorized - invalid api key',
    'Please run /login - API Error: 401 Invalid authentication credentials',
    'API Error: 401 OAuth access token has been revoked',
    'Token refresh failed: 401',
    'The Happier API returned HTTP 401.',
    'Request failed with status code 401',
    'Authentication failed: unauthorized',
    'Auth error: credential rejected',
    'Unauthorized: missing API key',
  ])('emits an actionable auth error for %s', (stderr) => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr(stderr, {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Authentication error');
  });

  it('uses caller-owned auth guidance without delegating classification', () => {
    const transport = new DefaultTransport('copilot', {
      authenticationErrorDetail: 'Run `copilot login`.',
    });

    expect(asStatusErrorMessage(transport.handleStderr('Token refresh failed: 401', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    }).message).detail).toBe('Run `copilot login`.');
  });

  it.each([
    '[agy-acp] WARN: failed to decode gen_metadata 401: cant skip wire type 6',
    'error decoding gen_metadata 401',
    'row 401',
    'port 401',
    'foo401bar',
    '401',
    'http://127.0.0.1:4010',
    'http://127.0.0.1:40123/webhook',
    '[16:31:14.401] waiting for next message',
    'TF401179: An active pull request already exists',
    'Discord Gateway close 4014',
    'next retry at 86401',
    'request completed for row 401',
    'HTTP request completed\nrow 401',
    'row 401\nrequest status: complete',
  ])('keeps incidental numeric text diagnostic for %s', (stderr) => {
    const transport = new DefaultTransport('generic');
    expect(transport.handleStderr(stderr, {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    }).message).toBeNull();
  });

  it('keeps contextual non-auth HTTP failures actionable without misclassifying them as auth', () => {
    const transport = new DefaultTransport('generic');
    const result = transport.handleStderr('Request failed with status code 500', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });

    expect(asStatusErrorMessage(result.message).detail).toContain('status code 500');
    expect(asStatusErrorMessage(result.message).detail).not.toContain('Authentication error');
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
