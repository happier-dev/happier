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
      expect.objectContaining({
        automationId: 'automation-1',
        runId: 'run-1',
        errorCode: 'worker_crashed',
        error: 'redacted',
      }),
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(privateDetail);
  });

  it('preserves typed failure identity and code locations without error content', () => {
    const privateDetail = 'Private prompt\nat injected (/private/customer-project/input.txt:12:4)';
    const error = Object.assign(new TypeError(privateDetail), { code: 'ERR_WORKFLOW_STORAGE' });
    error.stack = `TypeError: ${privateDetail}\n    at execute (/home/user/happier/apps/cli/src/daemon/workflows/production.ts:1280:9)\n    at async tick (/home/user/happier/apps/cli/src/daemon/automation/automationWorker.ts:475:7)`;

    logAutomationWarn('Run execution failed', error, { operation: 'execute', runId: 'run-1' });

    expect(loggerWarn).toHaveBeenCalledWith('[DAEMON AUTOMATION] Run execution failed', {
      operation: 'execute', runId: 'run-1', error: 'redacted', errorOperation: 'Run execution failed',
      errorName: 'TypeError', errorCode: 'ERR_WORKFLOW_STORAGE',
      errorStack: [
        'apps/cli/src/daemon/workflows/production.ts:1280:9',
        'apps/cli/src/daemon/automation/automationWorker.ts:475:7',
      ],
    });
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(privateDetail);
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('/home/user');
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('customer-project');
  });

  it('keeps bundled and Windows code locations while dropping private stack paths', () => {
    const error = Object.assign(new Error('private server response'), { code: 'ECONNABORTED' });
    error.stack = `${error.name}: ${error.message}\n    at refresh (file:///private/snapshot/package-dist/daemon-833jhsNv.mjs:4831:7)\n    at tick (C:\\Users\\alice\\happier\\apps\\cli\\src\\daemon\\automation\\automationWorker.ts:333:9)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at customer (/private/customer/code.js:2:1)`;
    logAutomationWarn('Failed to refresh automation assignments', error);
    expect(loggerWarn.mock.calls[0]?.[1]).toMatchObject({ errorName: 'Error', errorCode: 'ECONNABORTED',
      errorStack: ['package-dist/daemon-833jhsNv.mjs:4831:7',
        'apps/cli/src/daemon/automation/automationWorker.ts:333:9', 'node:internal/process/task_queues:104:5'] });
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toMatch(/private|alice|customer/);
  });
});
