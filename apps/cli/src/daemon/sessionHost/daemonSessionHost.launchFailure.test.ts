import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import {
  formatSessionRunnerFailureCause,
  projectSpawnSessionControlErrorResponse,
  SpawnSessionControlErrorResponseSchema,
} from '@/session/shared/spawnSessionContract';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createDaemonSessionHost } from './daemonSessionHost';

it('retains a host exit cause through the public Session spawn failure instead of losing it before readiness', async () => {
  await withTempDir('happier-host-launch-failure-', async directory => {
    const entrypoint = join(directory, 'failed-host.mjs');
    const failureCause = { code: 'EACCES', phase: 'client_start' as const, failureReason: 'permission_denied' as const };
    // Genuine process boundary: the host executable refuses startup before publishing its ready line.
    await writeFile(entrypoint, `process.stderr.write(${JSON.stringify(formatSessionRunnerFailureCause(failureCause) + '\n')}); process.exitCode = 1;\n`);
    const host = createDaemonSessionHost({
      directory,
      processEnv: { ...process.env, HAPPIER_DAEMON_STARTUP_SOURCE: '', HAPPIER_MANAGED_NODE_BIN: process.execPath },
      runnerLaunchOptions: {
        runtimeDecision: { runtime: 'node', argvPrefix: [entrypoint] },
        environment: { ...process.env, HAPPIER_MANAGED_NODE_BIN: process.execPath },
      },
      logDebug: () => {},
    });
    const added = await host.addSession({ trackingKey: 'failed-host-session',
      argv: ['codex', '--started-by', 'daemon', '--existing-session', 'reserved-session'], env: {}, cwd: directory });
    expect(added.status).toBe('failed');
    if (added.status !== 'failed' || added.result.type !== 'error') throw new Error('Expected host startup failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(added.result));
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }));
    expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: {
      code: 'CHILD_EXITED_BEFORE_WEBHOOK', childExit: { code: 1, signal: null }, failureCause,
    } });
  });
});
