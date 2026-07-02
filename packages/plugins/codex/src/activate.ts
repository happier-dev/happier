import type {
  McpServerSpecV1,
  PluginApiHookRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginDisposable,
  PluginHookHandler,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { detectCodexMcpServers } from './agent/mcp/detectCodexMcpServers.js';
import { createCodexBackendEngine } from './agent/engine/createCodexBackendEngine.js';
import {
  augmentCodexDaemonSpawnEnv,
  resolveCodexDaemonSpawnPrerequisites,
} from './agent/lifecycle/spawnHooks.js';

type CodexPluginApiV1 = Readonly<{
  registerBackendEngine?: (
    registration: BundledRegisterBackendEngineV1,
  ) => PluginDisposable | unknown;
  registerMcpDiscoveryProvider?: (
    registration: PluginApiMcpDiscoveryProviderRegistrationV1,
  ) => PluginDisposable | unknown;
  registerHook?: (
    registration: PluginApiHookRegistrationV1,
  ) => PluginDisposable | unknown;
}>;

type CodexSpawnPrerequisiteHookEvent = Parameters<typeof resolveCodexDaemonSpawnPrerequisites>[0];
type CodexSpawnPrerequisiteHookContext = Parameters<typeof resolveCodexDaemonSpawnPrerequisites>[1];
type CodexSpawnEnvHookEvent = Parameters<typeof augmentCodexDaemonSpawnEnv>[0];

function toHookEvent(value: unknown): CodexSpawnPrerequisiteHookEvent {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { payload: (value as Readonly<{ payload?: unknown }>).payload }
    : {};
}

function toSpawnPrerequisiteHookContext(value: unknown): CodexSpawnPrerequisiteHookContext {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CodexSpawnPrerequisiteHookContext
    : undefined;
}

const resolveCodexDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveCodexDaemonSpawnPrerequisites(
    toHookEvent(event),
    toSpawnPrerequisiteHookContext(context),
  );

const augmentCodexDaemonSpawnEnvHook: PluginHookHandler = (event) =>
  augmentCodexDaemonSpawnEnv(toHookEvent(event) satisfies CodexSpawnEnvHookEvent);

function toCodexMcpServerSpec(
  server: Awaited<ReturnType<typeof detectCodexMcpServers>>['servers'][number],
): McpServerSpecV1 | null {
  if (server.enabled === false) return null;
  if (server.transport !== 'stdio' || !server.stdio) return null;
  return {
    id: `codex.config.${server.name}`,
    name: server.name,
    transport: {
      kind: 'stdio',
      launch: {
        kind: 'binary',
        executablePath: server.stdio.command,
        args: server.stdio.args,
      },
    },
  };
}

export function activate(api?: CodexPluginApiV1): void {
  api?.registerBackendEngine?.({
    backendId: 'codex',
    create: createCodexBackendEngine,
  });
  api?.registerHook?.({
    hookId: 'backend.resolveRuntimePrerequisites',
    category: 'decision',
    scope: 'backend',
    filters: { backendId: 'codex' },
    executionKind: 'decide',
    handler: resolveCodexDaemonSpawnPrerequisitesHook,
  });
  api?.registerHook?.({
    hookId: 'spawn.augmentEnv',
    category: 'augmentation',
    scope: 'daemon',
    filters: { backendId: 'codex' },
    executionKind: 'augment',
    handler: augmentCodexDaemonSpawnEnvHook,
  });
  api?.registerMcpDiscoveryProvider?.({
    id: 'codex.config',
    discover: async () => {
      const detected = await detectCodexMcpServers({});
      return {
        servers: detected.servers
          .map(toCodexMcpServerSpec)
          .filter((server): server is McpServerSpecV1 => server !== null),
        warnings: detected.warnings,
      };
    },
  });
}
