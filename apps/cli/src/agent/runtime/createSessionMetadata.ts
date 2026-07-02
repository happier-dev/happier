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
    parseSessionMcpSelectionV1Json,
} from '@happier-dev/protocol';
import {
    applyAcpConfigOptionIntentSessionMetadata,
    applyAcpSessionModeIntentSessionMetadata,
    applyModelIntentSessionMetadata,
    applyPermissionModeIntentSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';

import type { AgentState, Metadata, PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import packageJson from '../../../package.json';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
import {
    parseSessionMetadataConfigOptionOverridesJson,
    type SessionMetadataConfigOptionOverrides,
} from './compat/sessionMetadataOverrides';
import { resolveRequestedSessionDirectory } from './resolveRequestedSessionDirectory';
import {
    HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
    parseSessionConnectedServicesBindingsJson,
} from './sessionConnectedServicesBindingsEnv';
import {
    HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
    parseSessionConnectedServiceMaterializationIdentityJson,
} from './sessionConnectedServiceMaterializationIdentityEnv';

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
    /** Session mode override to publish for the session (optional) */
    sessionModeId?: string;
    /** Timestamp (ms) for sessionModeId, used for arbitration across devices (optional) */
    sessionModeUpdatedAt?: number;
    /** Model override to publish for the session (optional) */
    modelId?: string;
    /** Timestamp (ms) for modelId, used for arbitration across devices (optional) */
    modelUpdatedAt?: number;
    /** Provider-owned metadata augmentation hook applied after shared metadata creation. */
    augmentMetadata?: ((metadata: Metadata) => Metadata) | null;
}

function consumeSessionEnv(
    name:
        | 'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON'
        | 'HAPPIER_SESSION_MCP_SELECTION_JSON'
        | typeof HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY
        | typeof HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
): string | null {
    const raw = process.env[name];
    delete process.env[name];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function parseSessionConfigOptionOverridesFromEnvironment(): SessionMetadataConfigOptionOverrides | null {
    const raw = consumeSessionEnv('HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON');
    return parseSessionMetadataConfigOptionOverridesJson(raw);
}

function applySessionConfigOptionOverridesToMetadata(
    metadata: Metadata,
    overrides: SessionMetadataConfigOptionOverrides | null,
): Metadata {
    if (!overrides) return metadata;

    let nextMetadata = metadata as Record<string, unknown>;
    for (const [configId, entry] of Object.entries(overrides.overrides)) {
        nextMetadata = applyAcpConfigOptionIntentSessionMetadata(nextMetadata, {
            v: 1,
            configId,
            value: entry.value,
            updatedAt: entry.updatedAt,
        });
    }

    return nextMetadata as Metadata;
}

function applyInitialIntentMetadata(metadata: Metadata, opts: CreateSessionMetadataOptions): Metadata {
    let nextMetadata = metadata;

    if (opts.permissionMode) {
        nextMetadata = applyPermissionModeIntentSessionMetadata(nextMetadata, {
            v: 1,
            permissionMode: opts.permissionMode,
            updatedAt: typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : Date.now(),
        }) as Metadata;
    }

    if (typeof opts.sessionModeId === 'string' && opts.sessionModeId.trim()) {
        nextMetadata = applyAcpSessionModeIntentSessionMetadata(nextMetadata, {
            v: 1,
            modeId: opts.sessionModeId.trim(),
            updatedAt: typeof opts.sessionModeUpdatedAt === 'number' ? opts.sessionModeUpdatedAt : Date.now(),
        }) as Metadata;
    }

    if (typeof opts.modelId === 'string' && opts.modelId.trim()) {
        nextMetadata = applyModelIntentSessionMetadata(nextMetadata, {
            v: 1,
            modelId: opts.modelId.trim(),
            updatedAt: typeof opts.modelUpdatedAt === 'number' ? opts.modelUpdatedAt : Date.now(),
        }) as Metadata;
    }

    return nextMetadata;
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
    const connectedServices = parseSessionConnectedServicesBindingsJson(
        consumeSessionEnv(HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY),
    );
    const connectedServiceMaterializationIdentity = parseSessionConnectedServiceMaterializationIdentityJson(
        consumeSessionEnv(HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY),
    );
    const sessionConfigOptionOverrides = parseSessionConfigOptionOverridesFromEnvironment();
    const metadataBase: Metadata = {
        path: resolveRequestedSessionDirectory({ requestedDirectory: opts.directory }),
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
        ...(mcpSelection ? { mcpSelectionV1: mcpSelection } : {}),
        ...(connectedServices ? { connectedServices } : {}),
        ...(connectedServiceMaterializationIdentity
            ? { connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity }
            : {}),
    };

    const metadata = (opts.augmentMetadata ?? ((current) => current))(
        applySessionConfigOptionOverridesToMetadata(
            applyInitialIntentMetadata(metadataBase, opts),
            sessionConfigOptionOverrides,
        ),
    );

    return { state, metadata };
}
