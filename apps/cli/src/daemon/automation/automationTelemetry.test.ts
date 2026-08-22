import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerDebug, loggerWarn } = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebug,
    warn: loggerWarn,
  },
}));

import { logAutomationWarn } from './automationTelemetry';

describe('automation telemetry', () => {
  beforeEach(() => {
    loggerWarn.mockReset();
  });

  it('keeps raw Run failure detail out of telemetry', () => {
    const privateDetail = 'The worker failed while reading /private/customer-project.';

    logAutomationWarn('Automation Run failed before settlement', new Error(privateDetail), {
      automationId: 'automation-1',
      runId: 'run-1',
      errorCode: 'worker_crashed',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      '[DAEMON AUTOMATION] Automation Run failed before settlement',
      {
        automationId: 'automation-1',
        runId: 'run-1',
        errorCode: 'worker_crashed',
        error: 'redacted',
      },
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(privateDetail);
  });
});
