import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createDaemonControlApp } from '../controlServer';
import { createStopSession } from './stopSession';

function readAudit(sessionId: string): unknown[] {
  const path = join(configuration.logsDir, 'terminal-host-kill-audit', 'audit.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)
    .filter((record) => record !== null && typeof record === 'object'
      && Reflect.get(record, 'sessionId') === sessionId);
}

describe('Stop caller attribution', () => {
  it('records an unknown legacy caller even when there is no runner to signal', async () => {
    const stop = createStopSession({ pidToTrackedSession: new Map(), readAttachmentState: async () => ({ status: 'absent' }) });
    await expect(stop('legacy-stop-attribution')).resolves.toEqual({ status: 'not_found' });
    logger.flushSync();
    const log = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8') : '';
    const attempts = log.split('\n').flatMap((line) => {
      const start = line.indexOf('{"event":"session_stop_attempt"');
      return start < 0 ? [] : [JSON.parse(line.slice(start)) as unknown];
    });
    expect(attempts).toContainEqual(expect.objectContaining({
      sessionId: 'legacy-stop-attribution', requestTransport: 'internal', requestSource: null,
    }));
  });

  it('preserves the requesting caller on the signal that terminates an active owned runner', async () => {
    // This test owns this child; Stop must still work while the child is active.
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const sessionId = 'active-stop-attribution';
    const source = { surface: 'mcp', requestingSessionId: 'requester-session', toolCallId: 'tool-1' };
    let app: ReturnType<typeof createDaemonControlApp> | undefined;
    try {
      const stop = createStopSession({
        pidToTrackedSession: new Map([[child.pid!, { pid: child.pid!, startedBy: 'daemon', happySessionId: sessionId, childProcess: child }]]),
        readAttachmentState: async () => ({ status: 'absent' }),
        waitForTrackedRunnersExit: async () => { await exited; return true; },
      });
      app = createDaemonControlApp({
        getChildren: () => [], machineId: 'local-machine', stopSession: stop,
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token',
      });
      const response = await app.inject({ method: 'POST', url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId, source: { ...source, toolInput: 'private input must not be logged' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'stopped' });
      expect(readAudit(sessionId)).toContainEqual(expect.objectContaining({
        signal: 'SIGTERM', runnerPid: child.pid, requestTransport: 'local_http', requestSource: source,
      }));
      expect(JSON.stringify(readAudit(sessionId))).not.toContain('private input');
    } finally {
      await app?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
