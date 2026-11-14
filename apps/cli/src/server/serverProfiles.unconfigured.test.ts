import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { readSettings } from '@/persistence';
import { addServerProfile, getActiveServerProfile, listServerProfiles } from './serverProfiles';
import { handleServerCommand } from '@/cli/commands/server';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

describe('server profiles without a default', () => {
  let home = '';
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  const previousExitCode = process.exitCode;
  beforeEach(async () => {
    process.exitCode = undefined;
    home = await createTempDir('happier-unconfigured-');
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
    reloadConfiguration();
  });
  afterEach(async () => {
    process.exitCode = previousExitCode;
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  });

  it('returns an explicit absent active profile without creating a default, then resolves a saved selection', async () => {
    expect(await getActiveServerProfile({ required: false })).toBeNull();
    expect(await listServerProfiles()).toEqual([]);
    await expect(getActiveServerProfile()).rejects.toThrow();
    const saved = await addServerProfile({ name: 'Saved', serverUrl: 'https://saved.example.test',
      webappUrl: 'https://saved.example.test', use: true });
    expect(await getActiveServerProfile({ required: false })).toMatchObject({ id: saved.id });
    expect((await readSettings()).servers).not.toHaveProperty('cloud');
  });

  it.each(['list', 'current', 'status'])('%s settles successfully when no server is configured', async command => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleServerCommand([command, '--json']);
      const result = JSON.parse(output.logs.join('\n'));
      expect(result).toMatchObject({ ok: true, data: command === 'list'
        ? { activeServerId: null, profiles: [] } : { active: null } });
      expect(process.exitCode).toBe(0);
      expect(await listServerProfiles()).toEqual([]);
    } finally { output.restore(); }
  });

  it('settles the native daemon service status task on a fresh Home', async () => {
    const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
    const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({ spec: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'daemon.service.status.v1', params: { target: { kind: 'local' } } } });
    expect(started).toHaveProperty('taskId');
    if (!('taskId' in started) || typeof started.taskId !== 'string') throw new Error('Status task did not start');
    expect(await adapter.wait({ taskId: started.taskId })).toMatchObject({ ok: true,
      data: { daemonRunning: false, needsAuth: true, machineId: null, daemonServerUrl: '' } });
    expect(await listServerProfiles()).toEqual([]);
  });
});
