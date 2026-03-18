/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for all backends (Claude, Codex, Gemini).
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import {
    computeNextMetadataConfigOptionOverrideV1,
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';
import {
    AcpConfigOptionOverridesV1Schema,
    buildAcpSessionModeOverrideV1,
    buildModelOverrideV1,
    parseSessionMcpSelectionV1Json,
} from '@happier-dev/protocol';

import type { AgentState, Metadata, PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import packageJson from '../../../package.json';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = string;

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor (claude, codex, gemini) */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** Working directory for the session (defaults to process.cwd()). */
    directory?: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
    /** Internal terminal runtime flags passed by the spawner (daemon/tmux wrapper). */
    terminalRuntime?: TerminalRuntimeFlags | null;
    /** Initial permission mode to publish for the session (optional) */
    permissionMode?: PermissionMode;
    /** Timestamp (ms) for permissionMode, used for arbitration across devices (optional) */
    permissionModeUpdatedAt?: number;
    /** ACP session mode override to publish for the session (optional; ACP backends only) */
    agentModeId?: string;
    /** Timestamp (ms) for agentModeId, used for arbitration across devices (optional) */
    agentModeUpdatedAt?: number;
    /** Model override to publish for the session (optional) */
    modelId?: string;
    /** Timestamp (ms) for modelId, used for arbitration across devices (optional) */
    modelUpdatedAt?: number;
    /** Generic ACP transport marker for sessions that run through an ACP backend. */
    acpProviderId?: string;
}

function consumeSessionEnv(name: 'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON' | 'HAPPIER_SESSION_MCP_SELECTION_JSON'): string | null {
    const raw = process.env[name];
    delete process.env[name];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function parseSessionConfigOptionOverridesFromEnvironment(): ReturnType<typeof AcpConfigOptionOverridesV1Schema.parse> | null {
    const raw = consumeSessionEnv('HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON');
    if (raw === null) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        const validated = AcpConfigOptionOverridesV1Schema.safeParse(parsed);
        return validated.success ? validated.data : null;
    } catch {
        return null;
    }
}

function applySessionConfigOptionOverridesToMetadata(
    metadata: Metadata,
    overrides: ReturnType<typeof AcpConfigOptionOverridesV1Schema.parse> | null,
): Metadata {
    if (!overrides) return metadata;

    let nextMetadata = metadata as Record<string, unknown>;
    for (const [configId, entry] of Object.entries(overrides.overrides)) {
        nextMetadata = computeNextMetadataConfigOptionOverrideV1({
            metadata: nextMetadata,
            configId,
            value: entry.value,
            updatedAt: entry.updatedAt,
        });
    }

    return nextMetadata as Metadata;
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex and Gemini backends, ensuring consistency across all backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'gemini',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    const profileIdEnv = process.env.HAPPIER_SESSION_PROFILE_ID;
    const profileId = profileIdEnv === undefined ? undefined : (profileIdEnv.trim() || null);
    const mcpSelection = parseSessionMcpSelectionV1Json(consumeSessionEnv('HAPPIER_SESSION_MCP_SELECTION_JSON'));
    const sessionConfigOptionOverrides = parseSessionConfigOptionOverridesFromEnvironment();
    const metadataBase: Metadata = {
        path: opts.directory ?? process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        ...(opts.terminalRuntime ? { terminal: buildTerminalMetadataFromRuntimeFlags(opts.terminalRuntime) } : {}),
        ...(profileIdEnv !== undefined ? { profileId } : {}),
        machineId: opts.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        sessionLogPath: logger.getLogPath(),
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        ...(opts.permissionMode && { permissionMode: opts.permissionMode }),
        ...(typeof opts.permissionModeUpdatedAt === 'number' && { permissionModeUpdatedAt: opts.permissionModeUpdatedAt }),
        ...(typeof opts.agentModeId === 'string' && opts.agentModeId.trim()
            ? (() => {
                  const override = buildAcpSessionModeOverrideV1({
                      updatedAt: typeof opts.agentModeUpdatedAt === 'number' ? opts.agentModeUpdatedAt : Date.now(),
                      modeId: opts.agentModeId.trim(),
                  });
                  return {
                      [SESSION_MODE_OVERRIDE_KEY]: override,
                      [LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY]: override,
                  };
              })()
            : {}),
        ...(typeof opts.modelId === 'string' && opts.modelId.trim()
            ? {
                  modelOverrideV1: buildModelOverrideV1({
                      updatedAt: typeof opts.modelUpdatedAt === 'number' ? opts.modelUpdatedAt : Date.now(),
                      modelId: opts.modelId.trim(),
                  }),
              }
            : {}),
        ...(typeof opts.acpProviderId === 'string' && opts.acpProviderId.trim().length > 0
            ? {
                  acpTransportV1: {
                      v: 1 as const,
                      provider: opts.acpProviderId.trim(),
                  },
              }
            : {}),
        ...(mcpSelection ? { mcpSelectionV1: mcpSelection } : {}),
    };

    const metadata = applySessionConfigOptionOverridesToMetadata(metadataBase, sessionConfigOptionOverrides);

    return { state, metadata };
}
