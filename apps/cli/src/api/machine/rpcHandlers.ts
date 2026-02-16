import { realpath } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import { collectBugReportMachineDiagnosticsSnapshot, readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionContinueWithReplayRpcParamsSchema } from '@happier-dev/protocol';
import { buildHappierReplayPromptFromDialog } from '@happier-dev/agents';
import { isPermissionMode } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { hydrateReplayDialogFromTranscript } from '@/session/replay/hydrateReplayDialogFromTranscript';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import psList from 'ps-list';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<boolean>;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
};

async function toCanonicalPath(path: string): Promise<string | null> {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  try {
    return await realpath(normalized);
  } catch {
    return null;
  }
}

function isKnownAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function parseEnvBoundedInt(
  name: string,
  bounds: Readonly<{ min: number; max: number }>,
  fallback: number | null,
): number | null {
  const rawValue = process.env[name];
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
}>): void {
  const { rpcHandlerManager, handlers } = params;
  const { spawnSession, stopSession, requestShutdown } = handlers;
  const memoryWorker = handlers.memory ?? null;

  // Register spawn session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (params: any) => {
    const {
      directory,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      agent,
      token,
      environmentVariables,
      profileId,
      terminal,
      resume,
      permissionMode,
      permissionModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      windowsRemoteSessionConsole,
      experimentalCodexResume,
      experimentalCodexAcp,
    } = params || {};

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    const envKeys = environmentVariables && typeof environmentVariables === 'object'
      ? Object.keys(environmentVariables as Record<string, unknown>)
      : [];
    const maxEnvKeysToLog = 20;
    const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
    logger.debug('[API MACHINE] Spawning session', {
      directory,
      sessionId,
      machineId,
      agent,
      approvedNewDirectoryCreation,
      profileId,
      hasToken: !!token,
      terminal,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasResume: typeof resume === 'string' && resume.trim().length > 0,
      experimentalCodexResume: experimentalCodexResume === true,
      experimentalCodexAcp: experimentalCodexAcp === true,
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const {
        sessionId: existingSessionId,
        directory,
        agent,
        resume,
        experimentalCodexResume,
        experimentalCodexAcp
      } = params;
      logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

      if (!directory) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Directory is required',
        };
      }
      if (!existingSessionId) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Session ID is required for resume',
        };
      }

      const result = await spawnSession({
        directory,
        agent,
        existingSessionId,
        approvedNewDirectoryCreation: true,
        resume: typeof resume === 'string' ? resume : undefined,
        permissionMode: normalizedPermissionMode,
        permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
        modelId: normalizedModelId,
        modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
        experimentalCodexResume: Boolean(experimentalCodexResume),
        experimentalCodexAcp: Boolean(experimentalCodexAcp),
      });

      if (result.type === 'error') {
        return result;
      }

      // For resume, we don't return a new session ID - we're reusing the existing one
      return { type: 'success' };
    }

    if (!directory) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
    }

    const result = await spawnSession({
      directory,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      agent,
      token,
      environmentVariables,
      profileId,
      terminal,
      resume,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      windowsRemoteSessionConsole,
      experimentalCodexResume,
      experimentalCodexAcp,
    });

    switch (result.type) {
      case 'success':
        logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
        return { type: 'success', sessionId: result.sessionId };

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        return result;
    }
  });

  if (memoryWorker) {
    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker,
    });
  }

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, async (raw: unknown) => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const {
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode,
      permissionModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      replay,
    } = parsed.data;

    if (!isKnownAgentId(agent)) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown agent id',
      };
    }

    const maxEnvSeedChars =
      parseEnvBoundedInt('HAPPIER_REPLAY_MAX_ENV_SEED_CHARS', { min: 1, max: 500_000 }, 20_000) ?? 20_000;
    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials || credentials.encryption.type !== 'dataKey') {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'This daemon is not provisioned with dataKey credentials and cannot decrypt transcripts for replay.',
      };
    }

    const hydrated = await hydrateReplayDialogFromTranscript({
      credentials,
      previousSessionId: replay.previousSessionId,
      limit: 200,
      maxTextChars: maxTextChars ?? undefined,
    }).catch(() => null);
    if (!hydrated || hydrated.dialog.length === 0) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }

    const seedDraft = buildHappierReplayPromptFromDialog({
      previousSessionId: replay.previousSessionId,
      strategy: replay.strategy ?? 'recent_messages',
      recentMessagesCount: replay.recentMessagesCount ?? 16,
      dialog: hydrated.dialog,
    });

    if (!seedDraft.trim()) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
      };
    }

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;

    logger.debug('[API MACHINE] Continuing session with replay', {
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      previousSessionId: replay.previousSessionId,
      dialogCount: hydrated.dialog.length,
      strategy: replay.strategy ?? 'recent_messages',
      recentMessagesCount: replay.recentMessagesCount ?? 16,
      seedMode: replay.seedMode ?? 'draft',
    });

    const shouldInjectSeedDraftAsInitialPrompt =
      replay.seedMode === 'daemon_initial_prompt' && seedDraft.length <= maxEnvSeedChars;

    const result = await spawnSession({
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      ...(shouldInjectSeedDraftAsInitialPrompt ? { initialPrompt: seedDraft } : {}),
    } satisfies SpawnSessionOptions);

    if (result.type === 'success') {
      if (!result.sessionId) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
          errorMessage: 'Spawn succeeded but no session id was returned',
        };
      }
      return { type: 'success', sessionId: result.sessionId, seedDraft };
    }

    return result;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, async () => {
    const markers = await listExecutionRunMarkers();

    let processIndex = new Map<number, DaemonExecutionRunProcessInfo>();
    try {
      const processes = await psList();
	      processIndex = new Map(
	        processes.map((proc) => [
	          proc.pid,
	          {
	            pid: proc.pid,
	            name: typeof proc.name === 'string' ? proc.name : undefined,
	            cpu: typeof (proc as any).cpu === 'number' ? (proc as any).cpu : undefined,
	            memory: typeof (proc as any).memory === 'number' ? (proc as any).memory : undefined,
	          },
	        ]),
	      );
    } catch {
      // best-effort; omit process stats if ps-list fails
    }

    const runs: DaemonExecutionRunEntry[] = markers.map((marker) => {
      const process = processIndex.get(marker.pid);
      return process ? { ...marker, process } : marker;
    });

    return { runs };
  });

  // Register stop session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_SESSION, async (params: any) => {
    const { sessionId } = params || {};

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const success = await stopSession(sessionId);
    if (!success) {
      throw new Error('Session not found or failed to stop');
    }

    logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
    return { message: 'Session stopped' };
  });

  // Register stop daemon handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_DAEMON, () => {
    logger.debug('[API MACHINE] Received stop-daemon RPC request');

    // Trigger shutdown callback after a delay
    setTimeout(() => {
      logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
      requestShutdown();
    }, 100);

    return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, async () => {
    return await collectBugReportMachineDiagnosticsSnapshot({
      daemonLogLimit: 5,
      stackLogLimit: 3,
      stackRuntimeMaxChars: 400_000,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    const diagnostics = await collectBugReportMachineDiagnosticsSnapshot({
      daemonLogLimit: 5,
      stackLogLimit: 3,
      stackRuntimeMaxChars: 400_000,
    });
    const allowedPaths = new Set<string>();
    if (diagnostics.daemonState?.daemonLogPath) {
      allowedPaths.add(diagnostics.daemonState.daemonLogPath.trim());
    }
    for (const entry of diagnostics.daemonLogs) {
      if (typeof entry.path === 'string' && entry.path.trim().length > 0) {
        allowedPaths.add(entry.path.trim());
      }
    }
    for (const entry of diagnostics.stackContext?.logCandidates ?? []) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        allowedPaths.add(entry.trim());
      }
    }

    const canonicalAllowedPaths = new Set<string>();
    for (const candidatePath of allowedPaths) {
      const canonicalPath = await toCanonicalPath(candidatePath);
      if (canonicalPath) {
        canonicalAllowedPaths.add(canonicalPath);
      }
    }

    let canonicalRequestedPath: string | null = null;
    if (path) {
      canonicalRequestedPath = await toCanonicalPath(path);
      if (!canonicalRequestedPath || !canonicalAllowedPaths.has(canonicalRequestedPath)) {
        return {
          ok: false,
          error: 'Requested log path is not allowed for bug report diagnostics',
        };
      }
    }

    const fallbackPath = Array.from(canonicalAllowedPaths)[0] ?? null;
    const targetPath = canonicalRequestedPath ?? fallbackPath;
    if (!targetPath) {
      return {
        ok: false,
        error: 'No daemon log path available',
      };
    }

    try {
      const tail = await readBugReportLogTail(targetPath, maxBytes);
      return {
        ok: true,
        path: targetPath,
        tail,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT, async (params: any) => {
    // Upload is intentionally delegated to UI/service clients via pre-signed URLs.
    // Keep the RPC for capability negotiation and future transport optimizations.
    return {
      ok: false,
      error: 'Daemon-side upload is not enabled; upload via report service pre-signed URL from UI.',
      uploadUrl: typeof params?.uploadUrl === 'string' ? params.uploadUrl : null,
    };
  });
}
