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
import { z } from 'zod/mini';

import { buildSessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { AgentSessionToolPolicyShapeV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { SessionMetadata, SessionModelSelectionIntentV1, RuntimeDescriptorV1, ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { SessionIdentityAdditionsV1Schema, type SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { type SessionAttestedContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { type SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import {
    buildCommittedLaunchMetadata as buildPortableCommittedLaunchMetadata,
    applyInitialSessionCreationFactsToMetadata,
    applySessionConfigOptionOverridesToMetadata,
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
import {
    resolveRequestedSessionDirectory,
    SESSION_DIRECTORY_KIND_ENV,
    SESSION_MACHINE_WORKSPACE_PATH_ENV,
} from './resolveRequestedSessionDirectory';
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
    allowedTools?: readonly string[];
    unlistedTools?: 'ask' | 'deny';
    /** Admitted birth facts from the ordinary Session creation owner. */
    identity?: SessionIdentityAdditions;
    memoryEnabled?: boolean;
    promptStack?: SessionPromptStackV1;
    accountSettings?: Readonly<Record<string, unknown>>;
    /** Selected runtime intent captured before this fresh Session is committed. */
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    /** Backend flavor identifier. */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** OS process generation captured by the runner before session creation. */
    hostProcessStartTimeMs?: number;
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
    | 'HAPPIER_SESSION_TOOL_POLICY_JSON'
    | 'HAPPIER_SESSION_INITIAL_IDENTITY_JSON'
    | 'HAPPIER_SESSION_INITIAL_MEMORY_ENABLED'
    | typeof SESSION_DIRECTORY_KIND_ENV
    | typeof SESSION_MACHINE_WORKSPACE_PATH_ENV
    | typeof HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY
    | typeof HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY;

const ONE_SHOT_LAUNCH_CONTROL_ENV_KEYS = [
    'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON',
    'HAPPIER_SESSION_TOOL_POLICY_JSON',
    'HAPPIER_SESSION_INITIAL_IDENTITY_JSON',
    'HAPPIER_SESSION_INITIAL_MEMORY_ENABLED',
    SESSION_MACHINE_WORKSPACE_PATH_ENV,
    SESSION_DIRECTORY_KIND_ENV,
    HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
    HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
] as const satisfies readonly LaunchControlEnvKey[];

export type SessionLaunchControlMetadata = Readonly<{
    allowedTools?: readonly string[];
    unlistedTools?: 'ask' | 'deny';
    identity?: SessionIdentityAdditions;
    memoryEnabled?: boolean;
    profileId?: string | null;
    connectedServices: ReturnType<typeof parseSessionConnectedServicesBindingsJson>;
    connectedServiceMaterializationIdentity: ReturnType<typeof parseSessionConnectedServiceMaterializationIdentityJson>;
    sessionConfigOptionOverrides: SessionMetadataConfigOptionOverrides | null;
    machineWorkspacePath: string | null;
    sessionDirectoryKind: 'path' | 'managed';
}>;

const sessionToolPolicyLaunchSchema = z.strictObject(AgentSessionToolPolicyShapeV1);

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
    const identityRaw = read('HAPPIER_SESSION_INITIAL_IDENTITY_JSON');
    const memoryEnabledRaw = read('HAPPIER_SESSION_INITIAL_MEMORY_ENABLED');
    const toolPolicyRaw = read('HAPPIER_SESSION_TOOL_POLICY_JSON');
    const toolPolicy = toolPolicyRaw === undefined
        ? undefined : sessionToolPolicyLaunchSchema.parse(JSON.parse(toolPolicyRaw));
    const identity = identityRaw === undefined ? undefined : SessionIdentityAdditionsV1Schema.parse(JSON.parse(identityRaw));
    const memoryEnabled: unknown = memoryEnabledRaw === undefined ? undefined : JSON.parse(memoryEnabledRaw);
    if (memoryEnabled !== undefined && typeof memoryEnabled !== 'boolean') {
        throw new Error('Invalid initial Session memory choice');
    }
    const captured: SessionLaunchControlMetadata = Object.freeze({
        ...toolPolicy,
        ...(identity !== undefined ? { identity } : {}),
        ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
        ...(profileIdRaw !== undefined ? { profileId: profileIdRaw.trim() || null } : {}),
        connectedServices: parseSessionConnectedServicesBindingsJson(
            readNonEmpty(HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY),
        ),
        connectedServiceMaterializationIdentity: parseSessionConnectedServiceMaterializationIdentityJson(
            readNonEmpty(HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY),
        ),
        sessionConfigOptionOverrides: parseSessionMetadataConfigOptionOverridesJson(
            readNonEmpty('HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON'),
        ),
        machineWorkspacePath: readNonEmpty(SESSION_MACHINE_WORKSPACE_PATH_ENV),
        sessionDirectoryKind: read(SESSION_DIRECTORY_KIND_ENV) === 'managed' ? 'managed' : 'path',
    });
    for (const key of ONE_SHOT_LAUNCH_CONTROL_ENV_KEYS) {
        delete processEnvironment[key];
    }
    return captured;
}

export { applyInitialSessionCreationFactsToMetadata, applySessionConfigOptionOverridesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';

/** CLI environment adapter for the shared portable birth metadata owner. */
export function buildCommittedLaunchMetadata(input: Readonly<{
    options: Omit<SpawnSessionOptions, 'directory'> & Partial<Pick<SpawnSessionOptions, 'directory'>>;
    directory?: string;
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    materializationIdentity?: ConnectedServiceMaterializationIdentityV1;
    accountSettings?: Readonly<Record<string, unknown>>;
}>): SessionMetadata {
    return buildPortableCommittedLaunchMetadata({ ...input,
        ...(input.directory !== undefined ? { host: os.hostname() } : {}),
    });
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
    const sessionPath = resolveRequestedSessionDirectory({ requestedDirectory: opts.directory });
    const metadataBase: Metadata = {
        path: sessionPath,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        ...(opts.terminalRuntime ? { terminal: buildTerminalMetadataFromRuntimeFlags(opts.terminalRuntime) } : {}),
        ...('profileId' in launchControlMetadata ? { profileId: launchControlMetadata.profileId } : {}),
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        hostProcessStartTimeMs: opts.hostProcessStartTimeMs,
        sessionLogPath: logger.getLogPath(),
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        ...(opts.runtimeDescriptorV1 ? { runtimeDescriptorV1: opts.runtimeDescriptorV1 } : {}),
        ...(opts.machineId ? {
            machineId: opts.machineId,
            sessionWorkspaceLocationV1: buildSessionWorkspaceLocationV1({
                machineId: opts.machineId,
                agentPath: sessionPath,
                machinePath: launchControlMetadata.machineWorkspacePath ?? sessionPath,
            }),
        } : {}),
        ...(launchControlMetadata.sessionDirectoryKind === 'managed'
            ? { sessionDirectoryV1: { v: 1 as const, kind: 'managed' as const } }
            : {}),
        ...(launchControlMetadata.connectedServices ? { connectedServices: launchControlMetadata.connectedServices } : {}),
        ...(launchControlMetadata.connectedServiceMaterializationIdentity
            ? { connectedServiceMaterializationIdentityV1: launchControlMetadata.connectedServiceMaterializationIdentity }
            : {}),
    };

    const metadata = (opts.augmentMetadata ?? ((current) => current))(
        applySessionConfigOptionOverridesToMetadata(
            applyInitialIntentMetadata(applyInitialSessionCreationFactsToMetadata(metadataBase, {
                allowedTools: opts.allowedTools ?? launchControlMetadata.allowedTools,
                unlistedTools: opts.unlistedTools ?? launchControlMetadata.unlistedTools,
                identity: opts.identity ?? launchControlMetadata.identity,
                memoryEnabled: opts.memoryEnabled ?? launchControlMetadata.memoryEnabled,
                promptStack: opts.promptStack,
                accountSettings: opts.accountSettings,
            }), opts),
            launchControlMetadata.sessionConfigOptionOverrides,
        ),
    );

    return { state, metadata };
}
