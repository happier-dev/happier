import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (mcp selection)', () => {
  it('exports session-scoped MCP selection JSON for the spawned runner', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: ['server-b'],
      },
    } as any;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_SESSION_MCP_SELECTION_JSON).toBe(JSON.stringify(options.mcpSelection));
  });
});
