import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { bindProcessLogger, Logger } from '@/ui/logger';
import { runMachineReconnectPhase } from './reconnectPhase';

it('records pending, completed and failed reconnect boundaries in the file without exposing operation data', async () => {
  vi.stubEnv('HAPPIER_LOG_LEVEL', 'info');
  const directory = await mkdtemp(join(tmpdir(), 'machine-reconnect-phase-'));
  const log = new Logger({ logFilePath: join(directory, 'daemon.log'),
    allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
  const restoreLogger = bindProcessLogger(log);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const ack = createDeferred<string>();
  const reading = runMachineReconnectPhase('metadata-publication', () => ack.promise);
  const readPhases = async () => {
    log.flushSync();
    return (await readFile(log.logFilePath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line.slice(line.indexOf('{'))));
  };
  try {
    expect(await readPhases()).toEqual([{ phase: 'metadata-publication', status: 'entered', durationMs: 0 }]);
    ack.resolve('private operation result');
    expect(await reading).toBe('private operation result');
    const failure = new Error('private credential-bearing failure');
    await expect(runMachineReconnectPhase('transfer-publication', async () => { throw failure; })).rejects.toBe(failure);
    const phases = await readPhases();
    expect(phases).toEqual([
      { phase: 'metadata-publication', status: 'entered', durationMs: 0 },
      { phase: 'metadata-publication', status: 'completed', durationMs: expect.any(Number) },
      { phase: 'transfer-publication', status: 'entered', durationMs: 0 },
      { phase: 'transfer-publication', status: 'failed', durationMs: expect.any(Number) },
    ]);
    expect(phases.every(phase => phase.durationMs >= 0)).toBe(true);
    expect(await readFile(log.logFilePath, 'utf8')).not.toContain('private');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    ack.resolve('cleanup');
    await reading;
    stdout.mockRestore(); stderr.mockRestore(); restoreLogger();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
