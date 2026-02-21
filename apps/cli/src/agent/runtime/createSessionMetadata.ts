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

import type { AgentId } from '@happier-dev/agents';
import { buildAcpSessionModeOverrideV1, buildModelOverrideV1 } from '@happier-dev/protocol';

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
export type BackendFlavor = AgentId;

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

    const metadata: Metadata = {
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
            ? {
                  acpSessionModeOverrideV1: buildAcpSessionModeOverrideV1({
                      updatedAt: typeof opts.agentModeUpdatedAt === 'number' ? opts.agentModeUpdatedAt : Date.now(),
                      modeId: opts.agentModeId.trim(),
                  }),
              }
            : {}),
        ...(typeof opts.modelId === 'string' && opts.modelId.trim()
            ? {
                  modelOverrideV1: buildModelOverrideV1({
                      updatedAt: typeof opts.modelUpdatedAt === 'number' ? opts.modelUpdatedAt : Date.now(),
                      modelId: opts.modelId.trim(),
                  }),
              }
            : {}),
    };

    return { state, metadata };
}
