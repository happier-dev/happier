import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionErrorCode } from '@/rpc/handlers/registerSessionHandlers';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { sanitizeEnvVarRecord } from '@/terminal/runtime/envVarSanitization';
import type { DaemonSpawnHooks } from '../spawnHooks';
import { buildAuthEnvUnexpandedErrorMessage, findUnexpandedAuthEnvironmentReferences } from './authEnvValidation';

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

  const agentId = typeof params.options.agent === 'string' ? params.options.agent : null;
  const explicitResumeId = typeof params.options.resume === 'string' && params.options.resume.trim().length > 0
    ? params.options.resume.trim()
    : null;

  let cleanupOnFailure: (() => void) | null = null;
  let cleanupOnExit: (() => void) | null = null;
  let effectiveExperimentalCodexAcp = params.options.experimentalCodexAcp;
  let codexAcpFallbackMessage: string | null = null;

  const chainCleanup = (first: (() => void) | null, second: (() => void) | null) => {
    if (!first) return second;
    if (!second) return first;
    return () => {
      try {
        first();
      } finally {
        second();
      }
    };
  };

  const authEnv: Record<string, string> = {};
  if (!params.options.token && params.connectedServiceAuth?.env) {
    Object.assign(authEnv, params.connectedServiceAuth.env);
    cleanupOnFailure = connectedCleanupOnFailure;
    cleanupOnExit = connectedCleanupOnExit;
  }
  if (params.options.token) {
    if (params.daemonSpawnHooks?.buildAuthEnv) {
      const built = await params.daemonSpawnHooks.buildAuthEnv({ token: params.options.token });
      Object.assign(authEnv, built.env);
      cleanupOnFailure = built.cleanupOnFailure ?? null;
      cleanupOnExit = built.cleanupOnExit ?? null;
    } else {
      authEnv.CLAUDE_CODE_OAUTH_TOKEN = params.options.token;
    }
    cleanupOnFailure = chainCleanup(connectedCleanupOnFailure, cleanupOnFailure);
    cleanupOnExit = chainCleanup(connectedCleanupOnExit, cleanupOnExit);
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

  let extraEnv = { ...profileEnv, ...sessionProfileEnv, ...sanitizedAuthEnv };
  params.logDebug(
    `[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`,
  );

  extraEnv = expandEnvironmentVariables(extraEnv, params.processEnv);
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

  if (params.daemonSpawnHooks?.validateSpawn) {
    const validation = await params.daemonSpawnHooks.validateSpawn({
      experimentalCodexAcp: effectiveExperimentalCodexAcp,
    });
    if (!validation.ok) {
      const shouldFallbackToMcp =
        agentId === 'codex' &&
        effectiveExperimentalCodexAcp === true &&
        explicitResumeId === null;

      if (!shouldFallbackToMcp) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          errorMessage: validation.errorMessage,
          cleanupOnFailure,
          cleanupOnExit,
        };
      }

      effectiveExperimentalCodexAcp = false;
      codexAcpFallbackMessage = `Codex ACP could not start (${validation.errorMessage}). Falling back to MCP for this new session.`;
      params.logWarn(`[DAEMON RUN] ${codexAcpFallbackMessage}`);

      const validationAfterFallback = await params.daemonSpawnHooks.validateSpawn({
        experimentalCodexAcp: effectiveExperimentalCodexAcp,
      });
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

  const extraEnvForChild = { ...extraEnv };
  delete extraEnvForChild.TMUX_SESSION_NAME;
  delete extraEnvForChild.TMUX_TMPDIR;
  if (explicitEnvKeysForChild.length > 0) {
    extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify(explicitEnvKeysForChild);
  }
  if (params.daemonSpawnHooks?.buildExtraEnvForChild) {
    Object.assign(
      extraEnvForChild,
      params.daemonSpawnHooks.buildExtraEnvForChild({
        experimentalCodexAcp: effectiveExperimentalCodexAcp,
      }),
    );
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
