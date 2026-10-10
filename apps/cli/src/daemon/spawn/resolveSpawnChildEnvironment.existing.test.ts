import { describe, expect, it } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('existing native state launch admission', () => {
  it('refuses an existing-state handoff launch without admitted Session metadata', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '/repo', resume: 'native-session', handoffStateTransfer: 'existing' },
      profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv: {},
      logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
  });
});
