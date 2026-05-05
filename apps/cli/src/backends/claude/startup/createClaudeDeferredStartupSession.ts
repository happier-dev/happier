import { readSessionAttachMetadataIdentityPolicyFromEnv } from '@/agent/runtime/readSessionAttachMetadataIdentityPolicyFromEnv';
import { createPreparedDeferredStartupBootstrap } from '@/agent/runtime/startup/createPreparedDeferredStartupBootstrap';
import type {
  DeferredStartupBootstrapResult,
  DeferredStartupPushSender,
} from '@/agent/runtime/startup/deferredStartupTypes';
import { readRequiredStartupMachineId } from '@/agent/runtime/startup/readRequiredStartupMachineId';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import type { Credentials } from '@/persistence';
import { resolvePermissionModeSeedForAgentStart } from '@/settings/permissions/permissionModeSeed';
import { logger } from '@/ui/logger';
import { normalizeStartingMode } from '@/agent/runtime/session/loop/resolveStartingMode';

import type { StartOptions } from '../runtime/claudeSessionRuntimeOptions';
import { inferPermissionIntentFromClaudeArgs } from '../utils/inferPermissionIntentFromArgs';
import { synchronizeClaudeStartupOverrides } from './synchronizeClaudeStartupOverrides';

function hasAttachFile(): boolean {
  const attachFile = typeof process.env.HAPPIER_SESSION_ATTACH_FILE === 'string'
    ? process.env.HAPPIER_SESSION_ATTACH_FILE.trim()
    : '';
  return attachFile.length > 0;
}

export function shouldUseClaudeDeferredStartup(options: StartOptions): boolean {
  const startedBy = options.startedBy ?? 'terminal';
  const startingMode = normalizeStartingMode(options.startingMode) ?? 'terminal';
  const existingSessionId =
    typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0
      ? options.existingSessionId.trim()
      : null;
  const inferredPermissionMode = inferPermissionIntentFromClaudeArgs(options.claudeArgs);
  const canFastStartAttach = Boolean(
    existingSessionId &&
    hasAttachFile() &&
    (typeof options.permissionMode === 'string' || inferredPermissionMode !== null),
  );

  return startedBy === 'terminal' && startingMode === 'terminal' && (!existingSessionId || canFastStartAttach);
}

export async function createClaudeDeferredStartupSession(params: Readonly<{
  credentials: Credentials;
  opts: StartOptions & Readonly<{ directory?: string }>;
  onPushSenderReady?: ((pushSender: DeferredStartupPushSender) => void | Promise<void>) | null;
}>): Promise<DeferredStartupBootstrapResult> {
  const { credentials, opts } = params;
  const workingDirectory =
    typeof opts.directory === 'string' && opts.directory.trim().length > 0
      ? opts.directory
      : process.cwd();
  const startedBy: 'terminal' | 'daemon' = opts.startedBy ?? 'terminal';
  const existingSessionId =
    typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim().length > 0
      ? opts.existingSessionId.trim()
      : undefined;
  const attachMetadataIdentityPolicy = existingSessionId ? readSessionAttachMetadataIdentityPolicyFromEnv() : null;
  const explicitPermissionMode = opts.permissionMode;
  const explicitPermissionModeUpdatedAt = opts.permissionModeUpdatedAt;
  const accountSettings = opts.accountSettings ?? null;
  const permissionModeSeed = resolvePermissionModeSeedForAgentStart({
    agentId: 'claude',
    explicitPermissionMode,
    inferredPermissionMode: inferPermissionIntentFromClaudeArgs(opts.claudeArgs),
    accountSettings,
  });
  const initialPermissionMode = permissionModeSeed.mode;
  opts.permissionMode = initialPermissionMode;

  const explicitModelId = typeof opts.modelId === 'string'
    ? opts.modelId.trim()
    : (typeof opts.model === 'string' ? opts.model.trim() : '');
  const initialModelId = explicitModelId ? explicitModelId : undefined;
  const initialModelUpdatedAt =
    typeof opts.modelUpdatedAt === 'number'
      ? opts.modelUpdatedAt
      : initialModelId
        ? Date.now()
        : 0;
  if (initialModelId) {
    opts.model = initialModelId;
    opts.modelId = initialModelId;
    opts.modelUpdatedAt = initialModelUpdatedAt;
  }

  const initialMachineId = await readRequiredStartupMachineId(
    '[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/happier-dev/happier/issues',
  );
  const bootstrap = await createPreparedDeferredStartupBootstrap({
    credentials,
    flavor: 'claude',
    workingDirectory,
    startedBy,
    initialMachineId,
    machineMetadata: initialMachineMetadata,
    uiLogPrefix: '[claude]',
    timingLogPrefix: '[claude-startup]',
    timingIncludeIds: [
      'vendor_spawn_invoked',
      'initialize_backend_api_context',
      'initialize_backend_run_session',
      'resolve_startup_permission_mode',
    ],
    initialPermissionMode,
    explicitPermissionMode,
    explicitPermissionModeUpdatedAt,
    sessionModeId: opts.sessionModeId,
    sessionModeUpdatedAt: opts.sessionModeUpdatedAt,
    modelId: initialModelId,
    modelUpdatedAt: initialModelUpdatedAt,
    existingSessionId,
    attachMetadataIdentityPolicy,
    terminalRuntime: opts.terminalRuntime ?? null,
    allowOfflineStub: true,
    startupSideEffectsOrder: 'persist-first',
    onBackgroundStartFailure: async (error) => {
      logger.debug('[claude-startup] Background attach failed (non-fatal)', error);
    },
    onSessionAttached: async ({ session, timing }) => {
      const stopSeedSpan = timing.startSpan('resolve_startup_permission_mode');
      await synchronizeClaudeStartupOverrides({
        session,
        sessionKind: existingSessionId ? 'attach' : 'fresh',
        opts,
      });
      stopSeedSpan();
    },
    onPushSenderReady: params.onPushSenderReady,
  });
  opts.onVendorSpawnInvoked = bootstrap.markVendorSpawnInvoked;

  return bootstrap;
}
