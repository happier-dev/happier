import { randomUUID } from 'node:crypto';

import type { ClaudeLocalPermissionBridgeManager } from '../runtime/terminal/permissions/createLocalPermissionBridgeManager';
import type { Session } from '../runtime/session/ClaudeSession';
import {
  startSessionHookServer,
  type StartSessionHookServerOptions,
} from '@/plugins/runtime/hooks/session/server';
import {
  generateHookPluginDirWithEnsuredRuntime,
  generateHookSettingsFileWithEnsuredRuntime,
} from '@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime';
import { buildDefaultPermissionHookResponse } from '@happier-dev/plugins-claude/agent';

type HookServer = Readonly<{ port: number; stop: () => void }>;
type HookServerOptions = StartSessionHookServerOptions;

export type ClaudeHookServerAdjunct = Readonly<{
  hookServer: HookServer;
  hookSettingsPath: string;
  /**
   * Path to an ephemeral Happier-generated plugin directory containing
   * `hooks/hooks.json`. When set, the spawned Claude CLI is launched with
   * `--plugin-dir <path>` so SessionStart + PermissionRequest hooks register via
   * the additive plugin channel. `null` when `HAPPIER_CLAUDE_HOOKS_DISABLED=1`.
   *
   * Why plugin-dir instead of the `--settings` hooks field: Claude Code treats
   * `--settings` as a single overlay for hooks (first wins). PATH-resident
   * wrappers (e.g. cmux) prepend their own `--settings`, silently dropping
   * Happier's hooks. `--plugin-dir` is additive across wrappers.
   */
  hookPluginDir: string | null;
  permissionHookSecret: string;
  /**
   * A stable reference passed into the shared session hook server.
   * The Claude session loop mutates this to adjust permission timeouts dynamically.
   */
  hookServerOptions: HookServerOptions;
}>;

export function createClaudeHookServerAdjunctSpec(params: Readonly<{
  getCurrentSession: () => Session | null;
  localPermissionBridgeManager: ClaudeLocalPermissionBridgeManager;
  localPermissionBridgeWaitIndefinitely: boolean;
  localPermissionBridgeTimeoutMs: number | null;
}>): Readonly<{
  permissionHookSecret: string;
  hookServerOptions: HookServerOptions;
  generateHookSettingsFile: (port: number) => Promise<string>;
  generateHookPluginDir: (port: number) => Promise<string | null>;
}> {
  const permissionHookSecret = randomUUID();

  const hookServerOptions: HookServerOptions = {
    session: () => {
      const currentSession = params.getCurrentSession();
      if (!currentSession) return null;
      return {
        providerId: 'claude',
        sessionId: currentSession.client.sessionId,
      };
    },
    onSessionHook: (sessionId, data) => {
      params.getCurrentSession()?.onSessionFound(sessionId, data);
    },
    onPermissionHook: async (data) => {
      return await params.localPermissionBridgeManager.handlePermissionHook(data);
    },
    defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
    permissionHookSecret,
    permissionRequestTimeoutMs: params.localPermissionBridgeWaitIndefinitely ? null : params.localPermissionBridgeTimeoutMs,
  };

  return {
    permissionHookSecret,
    hookServerOptions,
    generateHookSettingsFile: async (port) => {
      return await generateHookSettingsFileWithEnsuredRuntime(port, {
        enableLocalPermissionBridge: true,
        permissionHookSecret,
      });
    },
    generateHookPluginDir: async (port) => {
      return await generateHookPluginDirWithEnsuredRuntime(port, {
        enableLocalPermissionBridge: true,
        permissionHookSecret,
      });
    },
  };
}

export async function createClaudeHookServerAdjunct(params: Readonly<{
  getCurrentSession: () => Session | null;
  localPermissionBridgeManager: ClaudeLocalPermissionBridgeManager;
  localPermissionBridgeWaitIndefinitely: boolean;
  localPermissionBridgeTimeoutMs: number | null;
}>): Promise<ClaudeHookServerAdjunct> {
  const {
    permissionHookSecret,
    hookServerOptions,
    generateHookSettingsFile,
    generateHookPluginDir,
  } = createClaudeHookServerAdjunctSpec(params);

  const hookServer = await startSessionHookServer(hookServerOptions);

  const hookSettingsPath = await generateHookSettingsFile(hookServer.port);
  const hookPluginDir = await generateHookPluginDir(hookServer.port);

  return { hookServer, hookSettingsPath, hookPluginDir, permissionHookSecret, hookServerOptions };
}
