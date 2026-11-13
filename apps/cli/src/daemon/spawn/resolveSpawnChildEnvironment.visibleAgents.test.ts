import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const resolve = (options: SpawnSessionOptions, accountSettings: unknown = null) => resolveSpawnChildEnvironment({
  options, profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv: {},
  logDebug: () => {}, logInfo: () => {}, logWarn: () => {}, connectedServiceAuth: null,
  ...(accountSettings ? { accountSettings } : {}),
} as Parameters<typeof resolveSpawnChildEnvironment>[0]);

describe('resolveSpawnChildEnvironment (visible agents seeding)', () => {
  it('exports the run link and creation origin so the child holds them before its first turn', async () => {
    const executionRunLinkV1 = { v: 1, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };
    const sessionOriginV1 = { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'execution_run', runId: 'run_1' } };
    const result = await resolve({ directory: '.', executionRunLinkV1, sessionOriginV1 } as SpawnSessionOptions);
    expect(result.ok && result.extraEnvForChild.HAPPIER_EXECUTION_RUN_LINK_V1_JSON).toBe(JSON.stringify(executionRunLinkV1));
    expect(result.ok && result.extraEnvForChild.HAPPIER_SESSION_ORIGIN_V1_JSON).toBe(JSON.stringify(sessionOriginV1));
    const plain = await resolve({ directory: '.' } as SpawnSessionOptions);
    expect(plain.ok && plain.extraEnvForChild.HAPPIER_EXECUTION_RUN_LINK_V1_JSON).toBeUndefined();
    expect(plain.ok && plain.extraEnvForChild.HAPPIER_SESSION_ORIGIN_V1_JSON).toBeUndefined();
  });

  it('exports the account standalone prompt only for a fresh roleless creation with non-blank text', async () => {
    const settings = { standaloneSessionPromptV1: { v: 1, text: 'Be brief.', updatedAt: 3 } };
    const fresh = await resolve({ directory: '.' } as SpawnSessionOptions, settings);
    expect(fresh.ok && fresh.extraEnvForChild.HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON)
      .toBe(JSON.stringify({ v: 1, text: 'Be brief.', updatedAt: 3 }));
    const roled = await resolve({ directory: '.', sessionRoleV1: { v: 1, role: 'reviewer' } } as SpawnSessionOptions, settings);
    expect(roled.ok && roled.extraEnvForChild.HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON).toBeUndefined();
    const existing = await resolve({ directory: '.', existingSessionId: 's1' } as SpawnSessionOptions, settings);
    expect(existing.ok && existing.extraEnvForChild.HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON).toBeUndefined();
    const blank = await resolve({ directory: '.' } as SpawnSessionOptions, { standaloneSessionPromptV1: { v: 1, text: '  ' } });
    expect(blank.ok && blank.extraEnvForChild.HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON).toBeUndefined();
  });
});
