import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { bindProcessLogger, Logger } from '@/ui/logger';
import { runPluginAuthorPhase } from './phaseLog';

it('logs monotonic elapsed time for settled phases, including refusals and thrown failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-author-phase-log-'));
  const logPath = join(root, 'phases.log');
  const localLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
  const restoreLogger = bindProcessLogger(localLogger);
  const now = vi.spyOn(performance, 'now');
  try {
    now.mockReturnValueOnce(100).mockReturnValueOnce(12_400);
    await expect(runPluginAuthorPhase({ phase: 'dependency prep', projectRoot: root }, async () => 'prepared'))
      .resolves.toBe('prepared');
    now.mockReturnValueOnce(15_000).mockReturnValueOnce(16_100);
    const refused = { ok: false };
    await expect(runPluginAuthorPhase({ phase: 'build', projectRoot: root }, async () => refused, (result) => result.ok))
      .resolves.toBe(refused);
    now.mockReturnValueOnce(20_000).mockReturnValueOnce(20_200);
    const error = new Error('candidate failed');
    await expect(runPluginAuthorPhase({ phase: 'evaluate', projectRoot: root }, async () => { throw error; }))
      .rejects.toBe(error);
    localLogger.flushSync();
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('dependency prep completed in 12.3 s');
    expect(log).toContain('build failed in 1.1 s');
    expect(log).toContain('evaluate failed in 0.2 s');
    expect(log).toContain('"elapsedMs":12300');
    expect(log).toContain('"elapsedMs":1100');
    expect(log).toContain('"elapsedMs":200');
  } finally {
    now.mockRestore();
    restoreLogger();
    await rm(root, { recursive: true, force: true });
  }
});
