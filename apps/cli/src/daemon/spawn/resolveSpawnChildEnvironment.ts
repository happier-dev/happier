import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionErrorCode } from '@/rpc/handlers/registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import type { DaemonSpawnHooks } from '../spawnHooks';
import { buildAuthEnvUnexpandedErrorMessage, findUnexpandedAuthEnvironmentReferences } from './authEnvValidation';
import { resolveCodexBackendModeForRun } from '@/backends/codex/utils/resolveCodexBackendModeForRun';
import { SESSION_REQUESTED_DIRECTORY_ENV } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { dispatchDaemonSpawnHookEvent } from '@/extensions/hooks/execution/dispatchDaemonSpawnHookEvent';

function sanitizeCodexAcpFallbackDetail(detail: string): string {
  const normalized = detail.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

type ResolveSpawnChildEnvironmentSuccess = {
  ok: true;
  expandedEnvironmentVariables: Record<string, string>;
  extraEnvForChild: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
};

type ResolveSpawnChildEnvironmentFailure = {
  ok: false;
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
};

export type ResolveSpawnChildEnvironmentResult =
  | ResolveSpawnChildEnvironmentSuccess
  | ResolveSpawnChildEnvironmentFailure;

export async function resolveSpawnChildEnvironment(params: {
  happyHomeDir?: string;
  options: SpawnSessionOptions;
  profileEnvironmentVariables: Record<string, string>;
  daemonSpawnHooks: DaemonSpawnHooks | null;
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  connectedServiceAuth?: {
    env: Record<string, string>;
    cleanupOnFailure: (() => void) | null;
    cleanupOnExit: (() => void) | null;
  } | null;
}): Promise<ResolveSpawnChildEnvironmentResult> {
  const connectedCleanupOnFailure = params.connectedServiceAuth?.cleanupOnFailure ?? null;
  const connectedCleanupOnExit = params.connectedServiceAuth?.cleanupOnExit ?? null;

  const backendTarget = resolveConcreteBackendTargetRefV2(params.options.backendTarget);
  const agentId = (() => {
    if (!backendTarget || backendTarget.sourceKind !== 'built_in') {
      return null;
    }
    return backendTarget.backendId;
  })();
  const explicitResumeId = typeof params.options.resume === 'string' && params.options.resume.trim().length > 0
    ? params.options.resume.trim()
    : null;
  const canonicalRuntimeSelection = readCanonicalSpawnRuntimeSelection(params.options);
  const runtimeDescriptorV1 = canonicalRuntimeSelection.runtimeDescriptorV1;

  let cleanupOnFailure: (() => void) | null = null;
  let cleanupOnExit: (() => void) | null = null;
  let effectiveCodexBackendMode = canonicalRuntimeSelection.codexBackendMode;
  let codexAcpFallbackMessage: string | null = null;

  function buildRuntimeSelection() {
    return {
      ...(effectiveCodexBackendMode ? { codexBackendMode: effectiveCodexBackendMode } : {}),
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    };
  }

  async function readPluginSpawnDecision(): Promise<Readonly<{
    allowed: boolean;
    errorMessage: string | null;
  }>> {
    if (!params.happyHomeDir) {
      return { allowed: true, errorMessage: null };
    }

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: params.happyHomeDir,
      event: {
        eventId: 'backend.resolveRuntimePrerequisites',
        backendId: backendTarget?.backendId,
        backendTarget: backendTarget ?? undefined,
        machineId: params.options.machineId,
        cwd: params.options.directory,
        payload: {
          directory: params.options.directory,
          runtimeSelection: buildRuntimeSelection(),
          ...(explicitResumeId ? { resumeId: explicitResumeId } : {}),
        },
      },
    });

    const aggregate = result.aggregate;
    const allowed =
      aggregate?.executionKind === 'decide'
        ? aggregate.result !== null
          && typeof aggregate.result === 'object'
          && !Array.isArray(aggregate.result)
          && (aggregate.result as { allowed?: unknown }).allowed === true
        : true;

    if (allowed) {
      return {
        allowed: true,
        errorMessage: null,
      };
    }

    for (const outcome of result.outcomes) {
      if (outcome.status === 'rejected' && typeof outcome.error === 'string' && outcome.error.trim().length > 0) {
        return {
          allowed: false,
          errorMessage: outcome.error.trim(),
        };
      }
      if (outcome.status === 'fulfilled' && outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)) {
        const reason = (outcome.result as Record<string, unknown>).errorMessage
          ?? (outcome.result as Record<string, unknown>).message
          ?? (outcome.result as Record<string, unknown>).reason;
        if (typeof reason === 'string' && reason.trim().length > 0) {
          return {
            allowed: false,
            errorMessage: reason.trim(),
          };
        }
      }
    }

    return {
      allowed: false,
      errorMessage: 'Plugin spawn prerequisite hook denied daemon spawn.',
    };
  }

  async function readPluginSpawnEnvAugmentation(): Promise<Record<string, string>> {
    if (!params.happyHomeDir) {
      return {};
    }

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: params.happyHomeDir,
      event: {
        eventId: 'spawn.augmentEnv',
        backendId: backendTarget?.backendId,
        backendTarget: backendTarget ?? undefined,
        machineId: params.options.machineId,
        cwd: params.options.directory,
        payload: {
          directory: params.options.directory,
          runtimeSelection: buildRuntimeSelection(),
          ...(explicitResumeId ? { resumeId: explicitResumeId } : {}),
        },
      },
    });

    const aggregate = result.aggregate;
    if (
      aggregate?.executionKind !== 'augment'
      || !aggregate.result
      || typeof aggregate.result !== 'object'
      || Array.isArray(aggregate.result)
    ) {
      return {};
    }

    return sanitizeEnvVarRecord(aggregate.result as Record<string, string>);
  }

  if (agentId === 'codex') {
    effectiveCodexBackendMode = resolveCodexBackendModeForRun({
      codexBackendMode: effectiveCodexBackendMode,
      experimentalCodexAcpEnabledByDefault: false,
    });
  }

  const authEnv: Record<string, string> = {};
  if (params.connectedServiceAuth?.env) {
    Object.assign(authEnv, params.connectedServiceAuth.env);
    cleanupOnFailure = connectedCleanupOnFailure;
    cleanupOnExit = connectedCleanupOnExit;
  }
  const sanitizedAuthEnv = sanitizeEnvVarRecord(authEnv);

  let profileEnv: Record<string, string> = {};
  if (Object.keys(params.profileEnvironmentVariables).length > 0) {
    profileEnv = sanitizeEnvVarRecord(params.profileEnvironmentVariables);
    params.logInfo(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
    params.logDebug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
  } else {
    params.logDebug('[DAEMON RUN] No profile environment variables provided by caller; skipping profile env injection');
  }

  const explicitEnvKeysForChild = Array.from(new Set<string>([
    ...Object.keys(profileEnv),
    ...Object.keys(sanitizedAuthEnv),
  ]));

  const sessionProfileEnv: Record<string, string> = {};
  if (params.options.profileId !== undefined) {
    sessionProfileEnv.HAPPIER_SESSION_PROFILE_ID = params.options.profileId;
  }

  const expandedProfileEnv = expandEnvironmentVariables(
    { ...profileEnv, ...sessionProfileEnv },
    { ...params.processEnv, ...profileEnv, ...sessionProfileEnv },
  );
  const expandedAuthEnv = expandEnvironmentVariables(
    sanitizedAuthEnv,
    { ...params.processEnv, ...sanitizedAuthEnv },
  );

  let extraEnv = { ...expandedProfileEnv, ...expandedAuthEnv };
  params.logDebug(
    `[DAEMON RUN] Final environment variable keys (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`,
  );
  params.logDebug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

  const missingVarDetails = findUnexpandedAuthEnvironmentReferences(extraEnv);
  if (missingVarDetails.length > 0) {
    const errorMessage = buildAuthEnvUnexpandedErrorMessage(missingVarDetails);
    params.logWarn(`[DAEMON RUN] ${errorMessage}`);
    return {
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
      errorMessage,
      cleanupOnFailure,
      cleanupOnExit,
    };
  }

  if (params.daemonSpawnHooks?.resolveRuntimePrerequisites) {
    const validation = await params.daemonSpawnHooks.resolveRuntimePrerequisites(buildRuntimeSelection());
    if (!validation.ok) {
      const shouldFallbackToMcp =
        agentId === 'codex' &&
        effectiveCodexBackendMode === 'acp' &&
        explicitResumeId === null &&
        validation.reasonCode === 'codex_acp_unavailable';

      if (!shouldFallbackToMcp) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          errorMessage: validation.errorMessage,
          cleanupOnFailure,
          cleanupOnExit,
        };
      }

      // New sessions only: fall back to MCP when Codex ACP cannot run.
      // Explicit resume must fail closed (resuming via MCP is not supported).
      effectiveCodexBackendMode = 'mcp';
      codexAcpFallbackMessage = `Codex ACP could not start (${sanitizeCodexAcpFallbackDetail(validation.errorMessage)}). Falling back to MCP for this new session.`;
      params.logWarn(`[DAEMON RUN] ${codexAcpFallbackMessage}`);

      const validationAfterFallback = await params.daemonSpawnHooks.resolveRuntimePrerequisites(buildRuntimeSelection());
      if (!validationAfterFallback.ok) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          errorMessage: validationAfterFallback.errorMessage,
          cleanupOnFailure,
          cleanupOnExit,
        };
      }
    }
  }

  const pluginSpawnDecision = await readPluginSpawnDecision();
  if (!pluginSpawnDecision.allowed) {
    return {
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: pluginSpawnDecision.errorMessage ?? 'Plugin spawn prerequisite hook denied daemon spawn.',
      cleanupOnFailure,
      cleanupOnExit,
    };
  }

  const extraEnvForChild = { ...extraEnv };
  delete extraEnvForChild.TMUX_SESSION_NAME;
  delete extraEnvForChild.TMUX_TMPDIR;
  if (explicitEnvKeysForChild.length > 0) {
    extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify(explicitEnvKeysForChild);
  }
  if (params.daemonSpawnHooks?.augmentEnv) {
    Object.assign(
      extraEnvForChild,
      params.daemonSpawnHooks.augmentEnv(buildRuntimeSelection()),
    );
  }
  Object.assign(
    extraEnvForChild,
    await readPluginSpawnEnvAugmentation(),
  );
  if (params.options.transcriptStorage === 'direct') {
    extraEnvForChild.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
  }
  if (params.options.attachMetadataIdentityPolicy) {
    extraEnvForChild.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = params.options.attachMetadataIdentityPolicy;
  }
  if (params.options.mcpSelection) {
    extraEnvForChild.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify(params.options.mcpSelection);
  }
  if (params.options.sessionConfigOptionOverrides) {
    extraEnvForChild.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify(params.options.sessionConfigOptionOverrides);
  }
  extraEnvForChild[SESSION_REQUESTED_DIRECTORY_ENV] = params.options.directory;
  if (
    effectiveCodexBackendMode === 'mcp'
    || effectiveCodexBackendMode === 'acp'
    || effectiveCodexBackendMode === 'appServer'
  ) {
    extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE = effectiveCodexBackendMode;
  }
  if (codexAcpFallbackMessage) {
    extraEnvForChild.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE = codexAcpFallbackMessage;
  }

  return {
    ok: true,
    expandedEnvironmentVariables: extraEnv,
    extraEnvForChild,
    cleanupOnFailure,
    cleanupOnExit,
  };
}
