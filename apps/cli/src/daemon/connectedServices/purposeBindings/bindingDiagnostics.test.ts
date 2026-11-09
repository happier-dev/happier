import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindProcessLogger, Logger, logger } from '@/ui/logger';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { runConnectedAccountBindingStage, withConnectedAccountBindingDiagnostic } from './bindingDiagnostics';

describe('Connected Account binding diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records normal stages at debug and reserves warnings for failures', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    await withConnectedAccountBindingDiagnostic({ requestId: 'normal-binding' }, () =>
      runConnectedAccountBindingStage('account_purpose_read', () => null));
    expect(warn).not.toHaveBeenCalled();
    expect(debug.mock.calls.map(([, record]) => record)).toEqual([
      expect.objectContaining({ stage: 'account_purpose_read', event: 'begin' }),
      expect.objectContaining({ stage: 'account_purpose_read', event: 'end' }),
    ]);
    const failure = new Error('binding unavailable');
    await expect(withConnectedAccountBindingDiagnostic({ requestId: 'failed-binding' }, () =>
      runConnectedAccountBindingStage('account_purpose_read', () => { throw failure; }))).rejects.toBe(failure);
    expect(warn.mock.calls).toEqual([['[connected-account-binding-stage]', expect.objectContaining({
      requestId: 'failed-binding', event: 'failure', errorCode: 'binding_read_failed',
    })]]);
  });

  it('retains the admitted Happier Session identity on failures through the actual file redactor', async () => {
    const directory = createTempDirSync('happier-binding-diagnostics-');
    const sink = new Logger({ logFilePath: join(directory, 'binding.log'), pruneCurrentProcessLogs: false,
      allowDangerousRemoteLogging: false });
    const restore = bindProcessLogger(sink);
    try {
      const failure = new Error('binding unavailable');
      await expect(withConnectedAccountBindingDiagnostic({ sessionId: 'happier-session-1', requestId: 'request-1' }, () =>
        runConnectedAccountBindingStage('binding_read', () => { throw failure; }))).rejects.toBe(failure);
      sink.warnLocalFile('credential redaction remains enabled', { sessionId: 'private-session-cookie', token: 'private-token' });
      sink.flushSync();
      const content = readFileSync(sink.getLogPath(), 'utf8');
      expect(content).toContain('"agentSessionId":"happier-session-1"');
      expect(content).toContain('"requestId":"request-1"');
      expect(content).not.toMatch(/private-session-cookie|private-token/);
    } finally { restore(); removeTempDirSync(directory); }
  });

  it('omits arbitrary plugin error codes and values while retaining the exact failure', async () => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const failure = Object.assign(new Error('private-error-message'), {
      code: 'private_credential_encoded_as_a_code', body: { password: 'private-body' },
    });
    await expect(withConnectedAccountBindingDiagnostic({ requestId: 'request-1', sessionId: 'session-1' }, () =>
      runConnectedAccountBindingStage('target_resolution', () => { throw failure; }))).rejects.toBe(failure);
    expect(log.mock.calls).toContainEqual(['[connected-account-binding-stage]', {
      requestId: 'request-1', agentSessionId: 'session-1', stage: 'target_resolution', event: 'failure',
      durationMs: expect.any(Number), errorCode: 'binding_read_failed',
    }]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private[_-]/);
  });

  it('keeps both successful and failed reads unchanged when file logging fails', async () => {
    vi.spyOn(logger, 'debug').mockImplementation(() => { throw new Error('file unavailable'); });
    vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => { throw new Error('file unavailable'); });
    const failure = new Error('original operation failure');
    await withConnectedAccountBindingDiagnostic({ requestId: 'request-2' }, async () => {
      expect(await runConnectedAccountBindingStage('retained_binding', () => null)).toBeNull();
      await expect(runConnectedAccountBindingStage('account_purpose_read', () => { throw failure; })).rejects.toBe(failure);
    });
  });
});
