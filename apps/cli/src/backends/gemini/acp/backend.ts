/**
 * Gemini ACP Backend - Gemini CLI agent via ACP
 *
 * This module provides a factory function for creating a Gemini backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Gemini CLI is a reference ACP implementation from Google that supports
 * the --experimental-acp flag for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { geminiTransport } from '@/backends/gemini/acp/transport';
import { logger } from '@/ui/logger';
import {
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GEMINI_MODEL_ENV,
  DEFAULT_GEMINI_MODEL,
} from '@/backends/gemini/constants';
import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissions/modeCanonical';
import {
  readGeminiLocalConfigFromEnv,
  determineGeminiModel,
  getGeminiModelSource,
} from '@/backends/gemini/utils/config';
import { createGeminiMcpCliEnvironment } from '@/backends/gemini/mcp/createGeminiMcpCliEnvironment';
import { wrapBackendDisposeWithCleanup } from '@/backends/gemini/mcp/wrapBackendDisposeWithCleanup';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { hasGeminiChangeTitlePromptInstruction } from '@happier-dev/plugins-gemini/agent/acp/toolNames';
import { resolveGeminiAuthConfig } from '@happier-dev/plugins-gemini/agent/auth/resolution';

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Options for creating a Gemini ACP backend
 */
export interface GeminiBackendOptions extends AgentFactoryOptions {
  /** API key for Gemini (defaults to GEMINI_API_KEY or GOOGLE_API_KEY env var) */
  apiKey?: string;

  /** Current user email (from OAuth id_token) - used to match per-account project ID */
  currentUserEmail?: string;

  /**
   * Model to use. If undefined, will use local config, env var, or default.
   * If explicitly set to null, will use default (skip local config).
   * (defaults to GEMINI_MODEL env var or the built-in default)
   */
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
  /** The resolved model for UI/logging. Undefined means Gemini CLI default/auto routing. */
  model: string | undefined;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'local-config' | 'default';
}

/**
 * Create a Gemini backend using ACP (official SDK).
 *
 * The Gemini CLI must be installed and available in PATH.
 * Uses the --experimental-acp flag to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns GeminiBackendResult with backend and resolved model (single source of truth)
 */
export function createGeminiBackend(options: GeminiBackendOptions): GeminiBackendResult {
  const scopedEnv = options.env ?? {};
  const mergedSourceEnv = {
    ...process.env,
    ...scopedEnv,
  };

  // Try reading from local Gemini CLI config (token and model).
  const localConfig = readGeminiLocalConfigFromEnv(mergedSourceEnv);

  // OAuth access tokens are not Gemini API keys. OAuth auth is handled via ACP authenticate().
  const explicitApiKey =
    options.apiKey
    || scopedEnv[GEMINI_API_KEY_ENV]
    || scopedEnv[GOOGLE_API_KEY_ENV]
    || mergedSourceEnv[GEMINI_API_KEY_ENV]
    || mergedSourceEnv[GOOGLE_API_KEY_ENV]
    || null;

  const apiKey = explicitApiKey;

  if (!apiKey) {
    logger.debug('[Gemini] No API key found; using oauth-personal auth via Gemini CLI cached credentials.');
  }

  const geminiLaunch = requireProviderCliLaunchSpec('gemini', { processEnv: mergedSourceEnv });
  const modelSource = getGeminiModelSource(options.model, localConfig, mergedSourceEnv);
  const model =
    options.model === null
      ? undefined
      : options.model === undefined
        ? localConfig.model ?? undefined
        : options.model;
  const modelEnv =
    options.model !== undefined && options.model !== null && options.model !== 'auto'
      ? options.model
      : undefined;

  const intent = normalizePermissionModeToIntent(options.permissionMode ?? 'default') ?? 'default';
  const approvalMode =
    intent === 'yolo' || intent === 'bypassPermissions'
      ? 'yolo'
      : intent === 'acceptEdits' || intent === 'safe-yolo'
        ? 'auto_edit'
        : intent === 'plan'
          ? 'plan'
          : 'default';

  const sandboxEnabled = isTruthyEnv(mergedSourceEnv.HAPPIER_GEMINI_USE_SANDBOX);
  const approvalModeArgs = approvalMode === 'default' ? [] : ['--approval-mode', approvalMode];
  const geminiArgs = ['--acp', ...approvalModeArgs, ...(sandboxEnabled ? ['--sandbox'] : [])];

  const authConfig = resolveGeminiAuthConfig(mergedSourceEnv, apiKey);

  let googleCloudProject: string | null = null;
  if (localConfig.googleCloudProject) {
    const storedEmail = localConfig.googleCloudProjectEmail;
    const currentEmail = options.currentUserEmail;

    if (!storedEmail || storedEmail === currentEmail) {
      googleCloudProject = localConfig.googleCloudProject;
      logger.debug(`[Gemini] Using Google Cloud Project: ${googleCloudProject}${storedEmail ? ` (for ${storedEmail})` : ' (global)'}`);
    } else {
      logger.debug(`[Gemini] Skipping stored Google Cloud Project (stored for ${storedEmail}, current user is ${currentEmail || 'unknown'})`);
    }
  }

  const preparedMcpCliEnvironment = createGeminiMcpCliEnvironment({
    cwd: options.cwd,
    processEnv: mergedSourceEnv,
    mcpServers: options.mcpServers ?? {},
  });
  const {
    HAPPIER_GEMINI_ACP_AUTH_METHOD: _authMethod,
    HAPPIER_GEMINI_ACP_AUTH_META: _authMeta,
    GEMINI_MODEL: _scopedModel,
    ...safeScopedEnv
  } = scopedEnv;

  const backendOptions: AcpBackendOptions = {
    agentName: 'gemini',
    cwd: options.cwd,
    command: geminiLaunch.command,
    args: [...geminiLaunch.args, ...geminiArgs],
    env: {
      ...safeScopedEnv,
      ...preparedMcpCliEnvironment.env,
      ...(authConfig.shouldInjectApiKeyEnv && apiKey ? { [GEMINI_API_KEY_ENV]: apiKey, [GOOGLE_API_KEY_ENV]: apiKey } : {}),
      ...(modelEnv ? { [GEMINI_MODEL_ENV]: modelEnv } : {}),
      ...(googleCloudProject
        ? {
          GOOGLE_CLOUD_PROJECT: googleCloudProject,
          GOOGLE_CLOUD_PROJECT_ID: googleCloudProject,
        }
        : {}),
      NODE_ENV: 'production',
      DEBUG: '',
      GEMINI_CLI_NO_RELAUNCH: 'true',
    },
    unsetEnv: [
      GEMINI_MODEL_ENV,
      'HAPPIER_GEMINI_ACP_AUTH_METHOD',
      'HAPPIER_GEMINI_ACP_AUTH_META',
    ],
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: geminiTransport,
    authMethodId: authConfig.authMethodId,
    ...(authConfig.authMeta ? { authMeta: authConfig.authMeta } : {}),
    hasChangeTitleInstruction: hasGeminiChangeTitlePromptInstruction,
  };

  logger.debug('[Gemini] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model,
    modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: wrapBackendDisposeWithCleanup(new AcpBackend(backendOptions), preparedMcpCliEnvironment.cleanup),
    model,
    modelSource,
  };
}
