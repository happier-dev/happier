/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for backend agents.
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import {
    parseSessionMcpSelectionV1Json,
    type SessionModelSelectionIntentV1,
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
    /** Backend flavor identifier. */
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
    /** Canonical provider/native model-selection intent to publish for the session. */
    modelSelectionIntent?: SessionModelSelectionIntentV1;
    /** Provider-owned metadata augmentation hook applied after shared metadata creation. */
    augmentMetadata?: ((metadata: Metadata) => Metadata) | null;
    /** Non-secret launch controls captured once at the host/session boundary. */
    launchControlMetadata: SessionLaunchControlMetadata;
}

type LaunchControlEnvKey =
    | 'HAPPIER_SESSION_PROFILE_ID'
    | 'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON'
    | 'HAPPIER_SESSION_MCP_SELECTION_JSON'
    | typeof HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY
    | typeof HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY;

const ONE_SHOT_LAUNCH_CONTROL_ENV_KEYS = [
    'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON',
    'HAPPIER_SESSION_MCP_SELECTION_JSON',
    HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
    HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
] as const satisfies readonly LaunchControlEnvKey[];

export type SessionLaunchControlMetadata = Readonly<{
    profileId?: string | null;
    mcpSelection: ReturnType<typeof parseSessionMcpSelectionV1Json>;
    connectedServices: ReturnType<typeof parseSessionConnectedServicesBindingsJson>;
    connectedServiceMaterializationIdentity: ReturnType<typeof parseSessionConnectedServiceMaterializationIdentityJson>;
    sessionConfigOptionOverrides: SessionMetadataConfigOptionOverrides | null;
}>;

export function captureSessionLaunchControlMetadata(params: Readonly<{
    explicitEnvironment?: Readonly<Record<string, string>> | null;
    processEnvironment?: NodeJS.ProcessEnv;
}> = {}): SessionLaunchControlMetadata {
    const explicitEnvironment = params.explicitEnvironment ?? null;
    const processEnvironment = params.processEnvironment ?? process.env;
    const read = (name: LaunchControlEnvKey): string | undefined => {
        if (explicitEnvironment && Object.prototype.hasOwnProperty.call(explicitEnvironment, name)) {
            return explicitEnvironment[name];
        }
        return processEnvironment[name];
    };
    const readNonEmpty = (name: LaunchControlEnvKey): string | null => {
        const value = read(name);
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    };

    const profileIdRaw = read('HAPPIER_SESSION_PROFILE_ID');
    const captured: SessionLaunchControlMetadata = Object.freeze({
        ...(profileIdRaw !== undefined ? { profileId: profileIdRaw.trim() || null } : {}),
        mcpSelection: parseSessionMcpSelectionV1Json(readNonEmpty('HAPPIER_SESSION_MCP_SELECTION_JSON')),
        connectedServices: parseSessionConnectedServicesBindingsJson(
            readNonEmpty(HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY),
        ),
        connectedServiceMaterializationIdentity: parseSessionConnectedServiceMaterializationIdentityJson(
            readNonEmpty(HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY),
        ),
        sessionConfigOptionOverrides: parseSessionMetadataConfigOptionOverridesJson(
            readNonEmpty('HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON'),
        ),
    });
    for (const key of ONE_SHOT_LAUNCH_CONTROL_ENV_KEYS) {
        delete processEnvironment[key];
    }
    return captured;
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

    if (opts.modelSelectionIntent) {
        nextMetadata = applyModelIntentSessionMetadata(nextMetadata, opts.modelSelectionIntent) as Metadata;
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
 * This utility consolidates common session metadata creation logic, ensuring
 * consistency across backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: backendId,
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

    const launchControlMetadata = opts.launchControlMetadata;
    const metadataBase: Metadata = {
        path: resolveRequestedSessionDirectory({ requestedDirectory: opts.directory }),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        ...(opts.terminalRuntime ? { terminal: buildTerminalMetadataFromRuntimeFlags(opts.terminalRuntime) } : {}),
        ...('profileId' in launchControlMetadata ? { profileId: launchControlMetadata.profileId } : {}),
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
        ...(launchControlMetadata.mcpSelection ? { mcpSelectionV1: launchControlMetadata.mcpSelection } : {}),
        ...(launchControlMetadata.connectedServices ? { connectedServices: launchControlMetadata.connectedServices } : {}),
        ...(launchControlMetadata.connectedServiceMaterializationIdentity
            ? { connectedServiceMaterializationIdentityV1: launchControlMetadata.connectedServiceMaterializationIdentity }
            : {}),
    };

    const metadata = (opts.augmentMetadata ?? ((current) => current))(
        applySessionConfigOptionOverridesToMetadata(
            applyInitialIntentMetadata(metadataBase, opts),
            launchControlMetadata.sessionConfigOptionOverrides,
        ),
    );

    return { state, metadata };
}
