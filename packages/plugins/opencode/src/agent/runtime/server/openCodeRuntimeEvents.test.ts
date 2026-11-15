import { describe, expect, it } from 'vitest';

import { buildOpenCodeProviderErrorIssue, projectOpenCodeTurnCancellationCause } from './openCodeRuntimeEvents.js';

describe('projectOpenCodeTurnCancellationCause', () => {
  it.each([401, 403])('CC6 already projects a code-less HTTP %s through the shared owner', (status) => {
    expect(buildOpenCodeProviderErrorIssue({ code: 'opencode_provider_error', occurredAt: 1,
      error: { name: 'APIError', data: { statusCode: status } } })).toMatchObject({
      source: 'auth_error', failureCause: { failureReason: 'authentication_required', httpStatus: status },
    });
  });
  it.each([
    ['host_shutdown', 'hostShutdown'],
    ['session_dispose', 'sessionDispose'],
    ['runtime_recovery', 'runtimeRecovery'],
    ['user', 'user'],
    ['cancelled', 'providerCancelled'],
    [undefined, 'providerCancelled'],
  ] as const)('maps %s to the canonical Agent cancellation cause', (reason, expected) => {
    expect(projectOpenCodeTurnCancellationCause(reason)).toBe(expected);
  });
});
