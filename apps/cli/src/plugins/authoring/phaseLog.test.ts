import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { bindProcessLogger, Logger } from '@/ui/logger';
import { runPluginAuthorPhase } from './phaseLog';

it('records phase entry before a pending operation and completes the same phase once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-author-phase-entry-'));
  const logPath = join(root, 'phases.log');
  const localLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
  const restoreLogger = bindProcessLogger(localLogger);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const readRecords = async () => {
    localLogger.flushSync();
    const raw = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return raw.split('\n').filter(line => line.includes('[plugins]'))
      .map(line => JSON.parse(line.slice(line.indexOf('{'))) as { phase: string; outcome: string; pluginId: string });
  };
  const pending = runPluginAuthorPhase({ phase: 'adopt', projectRoot: root, pluginId: 'acme.pending-phase' }, async () => {
    await held;
    return 'adopted';
  });
  try {
    // Observe the real file while the operation has not settled. A logger
    // attached only to finally cannot explain this pending operation.
    expect(await readRecords()).toEqual([expect.objectContaining({
      phase: 'adopt', outcome: 'started', pluginId: 'acme.pending-phase',
    })]);
    release();
    await expect(pending).resolves.toBe('adopted');
    expect((await readRecords()).map(record => [record.phase, record.outcome]))
      .toEqual([['adopt', 'started'], ['adopt', 'completed']]);
  } finally {
    release();
    await pending;
    restoreLogger();
    await rm(root, { recursive: true, force: true });
  }
});

it('logs monotonic elapsed time for settled phases, including refusals and thrown failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-author-phase-log-'));
  const logPath = join(root, 'phases.log');
  const localLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
  const restoreLogger = bindProcessLogger(localLogger);
  const now = vi.spyOn(performance, 'now').mockReturnValue(30_000);
  try {
    now.mockReturnValueOnce(100).mockReturnValueOnce(12_400);
    await expect(runPluginAuthorPhase({ phase: 'dependency prep', projectRoot: root }, async () => 'prepared'))
      .resolves.toBe('prepared');
    now.mockReturnValueOnce(15_000).mockReturnValueOnce(16_100);
    const refused = { ok: false, code: 'plugin_dev_conflict', message: 'private failure payload' };
    await expect(runPluginAuthorPhase({ phase: 'build', projectRoot: root }, async () => refused, (result) => result.ok))
      .resolves.toBe(refused);
    now.mockReturnValueOnce(20_000).mockReturnValueOnce(20_200);
    const error = Object.assign(new Error('private failure payload'), { code: 'plugin_author_tool_failed' });
    await expect(runPluginAuthorPhase({ phase: 'evaluate', projectRoot: root }, async () => { throw error; }))
      .rejects.toBe(error);
    const namedError = new TypeError('private failure payload');
    await expect(runPluginAuthorPhase({ phase: 'adopt', projectRoot: root }, async () => { throw namedError; }))
      .rejects.toBe(namedError);
    const diagnosticFailure = { ok: false, diagnostics: [{ code: 'plugin_author_managed_tool_unavailable', message: 'private failure payload' }] };
    await expect(runPluginAuthorPhase({ phase: 'build', projectRoot: root }, async () => diagnosticFailure, result => result.ok))
      .resolves.toBe(diagnosticFailure);
    localLogger.flushSync();
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('dependency prep completed in 12.3 s');
    expect(log).toContain('build failed in 1.1 s');
    expect(log).toContain('evaluate failed in 0.2 s');
    expect(log).toContain('"elapsedMs":12300');
    expect(log).toContain('"elapsedMs":1100');
    expect(log).toContain('"elapsedMs":200');
    const failures = log.split('\n').filter(line => line.includes('[plugins]') && line.includes('"outcome":"failed"'))
      .map(line => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
    expect(failures.map(record => record.code)).toEqual(['plugin_dev_conflict', 'plugin_author_tool_failed', 'TypeError',
      'plugin_author_managed_tool_unavailable']);
    for (const failure of failures) {
      expect(Object.keys(failure).sort()).toEqual(['code', 'elapsedMs', 'outcome', 'phase', 'projectRoot']);
    }
    expect(log).not.toContain('private failure payload');
  } finally {
    now.mockRestore();
    restoreLogger();
    await rm(root, { recursive: true, force: true });
  }
});
