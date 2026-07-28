/**
 * Gemini ACP Backend - Gemini CLI agent via ACP
 * 
 * This module provides a factory function for creating a Gemini backend
 * that communicates using the Agent Client Protocol (ACP).
 * 
 * Gemini CLI is a reference ACP implementation from Google that supports
 * the --acp flag for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { geminiTransport } from '@/backends/gemini/acp/transport';
import { logger } from '@/ui/logger';
import {
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GEMINI_MODEL_ENV,
} from '@/backends/gemini/constants';
import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import {
  readGeminiLocalConfigFromEnv,
  determineGeminiModel,
  getGeminiModelSource
} from '@/backends/gemini/utils/config';
import { createGeminiMcpCliEnvironment } from '@/backends/gemini/mcp/createGeminiMcpCliEnvironment';
import { wrapBackendDisposeWithCleanup } from '@/backends/gemini/mcp/wrapBackendDisposeWithCleanup';
import {
  GEMINI_ACP_AUTH_METHOD_ENV,
  GEMINI_ACP_AUTH_META_ENV,
} from '@/backends/gemini/connectedServices/materializeGeminiConnectedServiceAuth';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveGeminiAcpFlag } from '@/backends/gemini/cli/detect';
import type { AcpAuthentication } from '@/agent/acp/AcpAuthentication';

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseGeminiAuthMeta(value: string | undefined): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function resolveGeminiAuthConfig(env: Readonly<Record<string, string | undefined>>, apiKey: string | null): {
  authentication: AcpAuthentication;
  shouldInjectApiKeyEnv: boolean;
} {
  const configuredMethod = env[GEMINI_ACP_AUTH_METHOD_ENV]?.trim();
  const configuredMeta = parseGeminiAuthMeta(env[GEMINI_ACP_AUTH_META_ENV]);
  if (configuredMethod === 'gateway') {
    return {
      authentication: {
        kind: 'static',
        methodId: 'gateway',
        ...(configuredMeta ? { meta: configuredMeta } : {}),
      },
      shouldInjectApiKeyEnv: false,
    };
  }
  if (configuredMethod === 'vertex-ai') {
    return {
      authentication: { kind: 'static', methodId: 'vertex-ai' },
      shouldInjectApiKeyEnv: false,
    };
  }
  if (isTruthyEnv(env.GOOGLE_GENAI_USE_VERTEXAI)) {
    return {
      authentication: { kind: 'static', methodId: 'vertex-ai' },
      shouldInjectApiKeyEnv: false,
    };
  }
  return apiKey
    ? {
        authentication: { kind: 'static', methodId: 'gemini-api-key' },
        shouldInjectApiKeyEnv: true,
      }
    : {
        authentication: { kind: 'static', methodId: 'oauth-personal' },
        shouldInjectApiKeyEnv: false,
      };
}

/**
 * Options for creating a Gemini ACP backend
 */
export interface GeminiBackendOptions extends AgentFactoryOptions {
  /** API key for Gemini (defaults to GEMINI_API_KEY or GOOGLE_API_KEY env var) */
  apiKey?: string;
  
  /** Current user email (from OAuth id_token) - used to match per-account project ID */
  currentUserEmail?: string;
  
  /** Model to use. If undefined, will use local config or default.
   *  If explicitly set to null, will use default (skip local config).
   *  (defaults to Gemini CLI auto-routing when no model is explicitly selected) */
  model?: string | null;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Optional Happier permission mode (applied to gemini --approval-mode). */
  permissionMode?: PermissionMode;
}

/**
 * Result of creating a Gemini backend
 */
export interface GeminiBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The concrete model when Gemini is not left to auto-route. */
  model?: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'local-config' | 'default';
}

/**
 * Create a Gemini backend using ACP (official SDK).
 *
 * The Gemini CLI must be installed and available in PATH.
 * Uses --acp to enable ACP mode, with a deprecated --experimental-acp fallback for old CLIs.
 *
 * @param options - Configuration options
 * @returns GeminiBackendResult with backend and any concrete configured model
 */
export function createGeminiBackend(options: GeminiBackendOptions): GeminiBackendResult {
  const scopedEnv = options.env ?? {};
  const {
    [GEMINI_MODEL_ENV]: _scopedGeminiModel,
    [GEMINI_ACP_AUTH_METHOD_ENV]: _scopedGeminiAuthMethod,
    [GEMINI_ACP_AUTH_META_ENV]: _scopedGeminiAuthMeta,
    ...scopedEnvWithoutModelAndAuthControl
  } = scopedEnv;
  const mergedSourceEnv = {
    ...process.env,
    ...scopedEnv,
  };
  const {
    [GEMINI_MODEL_ENV]: _inheritedGeminiModel,
    ...processEnvWithoutGeminiModel
  } = process.env;
  const modelSourceEnv = {
    ...processEnvWithoutGeminiModel,
    ...scopedEnvWithoutModelAndAuthControl,
  };

  // Resolve API key from multiple sources (in priority order):
  // 1. Local Gemini CLI config files (~/.gemini/) (API keys only)
  // 2. GEMINI_API_KEY environment variable
  // 3. GOOGLE_API_KEY environment variable - lowest priority
  
  // Try reading from local Gemini CLI config (token and model)
  const localConfig = readGeminiLocalConfigFromEnv(modelSourceEnv);
  
  // Important: OAuth access tokens (from oauth_creds.json or gcloud ADC) are NOT Gemini API keys.
  // We only treat explicit API key sources as GEMINI_API_KEY inputs. OAuth-based auth is handled
  // via ACP authenticate() using oauth-personal.
  const explicitApiKey =
    options.apiKey ||
    scopedEnv[GEMINI_API_KEY_ENV] ||
    scopedEnv[GOOGLE_API_KEY_ENV] ||
    mergedSourceEnv[GEMINI_API_KEY_ENV] ||
    mergedSourceEnv[GOOGLE_API_KEY_ENV] ||
    localConfig.token ||
    null;

  const apiKey = explicitApiKey;

  if (!apiKey) {
    // OAuth-personal is a valid default auth path; avoid surfacing this as a warning.
    logger.debug(`[Gemini] No API key found; using oauth-personal auth via Gemini CLI cached credentials.`);
  }

  // Resolve gemini CLI command (supports managed installs, overrides, and PATH)
  const geminiLaunch = requireProviderCliLaunchSpec('gemini', { processEnv: mergedSourceEnv });

  // Get model from options, local config, or default. Inherited GEMINI_MODEL is
  // scrubbed so Happier metadata does not override Gemini CLI auto routing.
  // Priority: options.model (if provided) > local config > default
  // If options.model is explicitly null, skip local config and use default.
  const model = determineGeminiModel(options.model, localConfig, modelSourceEnv);
  const modelSource = getGeminiModelSource(options.model, localConfig, modelSourceEnv);
  const shouldSetGeminiModelEnv = modelSource === 'explicit' && model.trim().toLowerCase() !== 'auto';
  const reportedModel = modelSource === 'default' ? undefined : model;

  const intent = normalizePermissionModeToIntent(options.permissionMode ?? 'default') ?? 'default';
  const approvalMode =
    intent === 'yolo' || intent === 'bypassPermissions'
      ? 'yolo'
      : intent === 'acceptEdits' || intent === 'safe-yolo'
        ? 'auto_edit'
        : intent === 'plan'
          ? 'plan'
          : 'default';

  // Gemini CLI's `--sandbox` can prevent ACP from answering `initialize` (hangs before stdio bridge is ready).
  // Keep it OFF by default and let Happier permissions enforce safety; opt-in via env when needed.
  const sandboxEnabled = isTruthyEnv(
    mergedSourceEnv.HAPPIER_GEMINI_USE_SANDBOX
  );

  // Build args - ACP + provider-native approvals.
  // GEMINI_MODEL is only set for explicit selections; otherwise Gemini CLI keeps its own auto routing.
  // We don't use --model flag to avoid potential stdout conflicts with ACP protocol.
  const approvalModeArgs = approvalMode === 'default' ? [] : ['--approval-mode', approvalMode];
  const acpFlag = resolveGeminiAcpFlag({
    command: geminiLaunch.command,
    baseArgs: geminiLaunch.args,
    env: mergedSourceEnv,
  });
  const geminiArgs = [acpFlag, ...approvalModeArgs, ...(sandboxEnabled ? ['--sandbox'] : [])];

  // Gemini CLI ACP requires an explicit authenticate() call before session/new, otherwise it can
  // return "Authentication required" even when local credentials are present.
  const authConfig = resolveGeminiAuthConfig(mergedSourceEnv, apiKey);

  // Get Google Cloud Project from local config (for Workspace accounts)
  // Only use if: no email stored (global), or email matches current user
  let googleCloudProject: string | null = null;
  if (localConfig.googleCloudProject) {
    const storedEmail = localConfig.googleCloudProjectEmail;
    const currentEmail = options.currentUserEmail;

    // Use project if: no email stored (applies to all), or emails match
    if (!storedEmail || storedEmail === currentEmail) {
      googleCloudProject = localConfig.googleCloudProject;
      logger.debug(`[Gemini] Using Google Cloud Project: ${googleCloudProject}${storedEmail ? ` (for ${storedEmail})` : ' (global)'}`);
    } else {
      logger.debug(`[Gemini] Skipping stored Google Cloud Project (stored for ${storedEmail}, current user is ${currentEmail || 'unknown'})`);
    }
  }
  const preparedGeminiCliEnvironment = createGeminiMcpCliEnvironment({
    cwd: options.cwd,
    processEnv: mergedSourceEnv,
  });

  const unsetEnv = [
    GEMINI_ACP_AUTH_METHOD_ENV,
    GEMINI_ACP_AUTH_META_ENV,
    ...(shouldSetGeminiModelEnv ? [] : [GEMINI_MODEL_ENV]),
  ];

  const backendOptions: AcpBackendOptions = {
    agentName: 'gemini',
    cwd: options.cwd,
    command: geminiLaunch.command,
    args: [...geminiLaunch.args, ...geminiArgs],
    env: {
      ...scopedEnvWithoutModelAndAuthControl,
      ...preparedGeminiCliEnvironment.env,
      ...(authConfig.shouldInjectApiKeyEnv && apiKey
        ? { [GEMINI_API_KEY_ENV]: apiKey, [GOOGLE_API_KEY_ENV]: apiKey }
        : {}),
      ...(shouldSetGeminiModelEnv ? { [GEMINI_MODEL_ENV]: model } : {}),
      // Pass Google Cloud Project for Workspace accounts
      ...(googleCloudProject ? { 
        GOOGLE_CLOUD_PROJECT: googleCloudProject,
        GOOGLE_CLOUD_PROJECT_ID: googleCloudProject,
      } : {}),
      // Suppress debug output from gemini CLI to avoid stdout pollution
      NODE_ENV: 'production',
      DEBUG: '',
      // Prevent gemini-cli from relaunching itself (relaunch can break ACP stdio wiring).
      GEMINI_CLI_NO_RELAUNCH: 'true',
    },
    unsetEnv,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: geminiTransport,
    authentication: authConfig.authentication,
	    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
	    hasChangeTitleInstruction: (prompt: string) => {
	      const lower = prompt.toLowerCase();
	      return (
	        CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias)) ||
	        lower.includes('change title') ||
	        lower.includes('set title')
	      );
	    },
	  };

  logger.debug('[Gemini] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: wrapBackendDisposeWithCleanup(new AcpBackend(backendOptions), preparedGeminiCliEnvironment.cleanup),
    model: reportedModel,
    modelSource,
  };
}
