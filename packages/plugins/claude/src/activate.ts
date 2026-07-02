import type {
  McpServerSpecV1,
  PluginApiHookRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginDisposable,
  PluginHookHandler,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { detectClaudeMcpServers } from './agent/mcp/detectServers.js';
import { createClaudeBackendEngine } from './agent/runtime/engine.js';
import {
  augmentClaudeDaemonSpawnEnv,
  resolveClaudeDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';

type ClaudePluginApiV1 = Readonly<{
  registerBackendEngine: (registration: BundledRegisterBackendEngineV1) => PluginDisposable | unknown;
  registerMcpDiscoveryProvider: (
    registration: PluginApiMcpDiscoveryProviderRegistrationV1,
  ) => PluginDisposable | unknown;
  registerHook?: (
    registration: PluginApiHookRegistrationV1,
  ) => PluginDisposable | unknown;
}>;

type ClaudeSpawnPrerequisiteHookEvent = Parameters<typeof resolveClaudeDaemonSpawnPrerequisites>[0];
type ClaudeSpawnPrerequisiteHookContext = Parameters<typeof resolveClaudeDaemonSpawnPrerequisites>[1];
type ClaudeSpawnEnvHookEvent = Parameters<typeof augmentClaudeDaemonSpawnEnv>[0];

function toHookEvent(value: unknown): ClaudeSpawnPrerequisiteHookEvent {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { payload: (value as Readonly<{ payload?: unknown }>).payload }
    : {};
}

function toSpawnPrerequisiteHookContext(value: unknown): ClaudeSpawnPrerequisiteHookContext {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ClaudeSpawnPrerequisiteHookContext
    : undefined;
}

const resolveClaudeDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveClaudeDaemonSpawnPrerequisites(
    toHookEvent(event),
    toSpawnPrerequisiteHookContext(context),
  );

const augmentClaudeDaemonSpawnEnvHook: PluginHookHandler = (event) =>
  augmentClaudeDaemonSpawnEnv(toHookEvent(event) satisfies ClaudeSpawnEnvHookEvent);

function toRedactedEnvKeys(envKeys: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (envKeys.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(envKeys.map((key) => [key, ''])));
}

function toClaudeMcpServerSpec(
  server: Awaited<ReturnType<typeof detectClaudeMcpServers>>['servers'][number],
): McpServerSpecV1 | null {
  if (server.transport === 'stdio' && server.stdio) {
    return {
      id: `claude.config.${server.name}`,
      name: server.name,
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'binary',
          executablePath: server.stdio.command,
          args: server.stdio.args,
          ...(toRedactedEnvKeys(server.envKeys) ? { env: toRedactedEnvKeys(server.envKeys) } : {}),
        },
      },
    };
  }
  if ((server.transport === 'http' || server.transport === 'sse') && server.remote) {
    return {
      id: `claude.config.${server.name}`,
      name: server.name,
      transport: {
        kind: server.transport,
        url: server.remote.url,
      },
    };
  }
  return null;
}

export function activate(api: ClaudePluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'claude',
    create: async (ctx) => {
      ctx.logger.info('[plugins/claude] Creating backend engine');
      return createClaudeBackendEngine(ctx);
    },
  });
  api.registerHook?.({
    hookId: 'backend.resolveRuntimePrerequisites',
    category: 'decision',
    scope: 'backend',
    filters: { backendId: 'claude' },
    executionKind: 'decide',
    handler: resolveClaudeDaemonSpawnPrerequisitesHook,
  });
  api.registerHook?.({
    hookId: 'spawn.augmentEnv',
    category: 'augmentation',
    scope: 'daemon',
    filters: { backendId: 'claude' },
    executionKind: 'augment',
    handler: augmentClaudeDaemonSpawnEnvHook,
  });
  api.registerMcpDiscoveryProvider({
    id: 'claude.config',
    discover: async (input) => {
      const detected = await detectClaudeMcpServers({
        directory: input?.directory ?? null,
      });
      return {
        servers: detected.servers
          .map(toClaudeMcpServerSpec)
          .filter((server): server is McpServerSpecV1 => server !== null),
        warnings: detected.warnings,
      };
    },
  });
}
