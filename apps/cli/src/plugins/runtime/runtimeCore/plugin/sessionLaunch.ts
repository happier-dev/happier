import type { PermissionMode } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { SessionAttachSecret } from '@/agent/runtime/sessionAttach';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { BackendTargetRefV2Schema, normalizeBackendTargetRefV2InputToV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveSessionModelSelectionInputRefV1, SessionModelSelectionResolutionError, SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionInitialAccessDraftV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { BackendTargetRefV2Input, AcpConfigOptionOverridesV1, AgentSessionStartupInstructionsV1, MachinePoolSelectionOriginV1, SessionCreationCorrespondenceV1, SessionCreationTagV1, SessionModelSelectionV1, SessionInitialAccessDraftV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import {
  NativeForkSourceSchema,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';
import {
  bindAgentCliLaunchSpec,
  type BoundAgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

export type PluginSessionBindingInput = Readonly<{
    credentials: StoredCredentials;
    /** Host-private exact managed Agent launch admitted before Session construction. */
    agentCliLaunch?: BoundAgentCliLaunchSpec;
    sessionCreationTag?: SessionCreationTagV1;
    sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
    placementOrigin?: MachinePoolSelectionOriginV1;
    initialTitle?: string;
    initialAccess?: SessionInitialAccessDraftV1;
    primaryTeamId?: string | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    bootstrap: Readonly<{
        runtimeDescriptorV1?: AgentSessionOpenRequest['runtimeDescriptorV1'];
        workingDirectory?: string;
        target?: BackendTargetRefV2Input;
        source?: 'daemon' | 'terminal';
        accountSettingsContext?: AccountSettingsContext | null;
        environmentVariables?: Readonly<Record<string, string>>;
        unsetEnvironmentVariables?: readonly string[];
        resolveLateEnvironment?: HostPrivateLateSessionEnvironmentResolver;
    }>;
  resume: Readonly<{
        existingSessionId?: string;
        sessionAttachFilePath?: string;
        sessionAttachSecret?: SessionAttachSecret;
        resumeSessionId?: string;
  }>;
  nativeForkSource?: NativeForkSource;
  agentSessionStartupInstructionsV1?: AgentSessionStartupInstructionsV1;
    runtimePreferences: Readonly<{
        terminal?: TerminalRuntimeFlags | null;
        startingMode?: 'terminal' | 'remote' | 'local';
        permission?: Readonly<{
            mode: PermissionMode;
            updatedAt?: number;
        }>;
        sessionMode?: Readonly<{
            id: string;
            updatedAt?: number;
        }>;
        modelSelection?: SessionModelSelectionV1;
        configurationOptions?: AcpConfigOptionOverridesV1;
    }>;
}>;

export type HostPrivateLateSessionEnvironmentResolver = (
  input: Readonly<{ sessionId: string }>,
) => Promise<
  Readonly<{
    environmentVariables: Readonly<Record<string, string>>;
    unsetEnvironmentVariables: readonly string[];
    sensitiveEnvironmentVariableNames: readonly string[];
    /**
     * Host-selected Connected Account references for this exact Session.
     * They remain data-only: the late resolver cannot select, materialize, or
     * expose account credentials.
     */
    sessionConnectedAccounts?: NonNullable<AgentSessionOpenRequest['connectedAccounts']>;
  }>
>;

export type PluginHostSessionRuntimeOptions = Readonly<{
    runtimeDescriptorV1?: AgentSessionOpenRequest['runtimeDescriptorV1'];
    credentials: StoredCredentials;
    agentSessionStartupInstructionsV1?: AgentSessionStartupInstructionsV1;
    sessionCreationTag?: SessionCreationTagV1;
    sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
    placementOrigin?: MachinePoolSelectionOriginV1;
    initialTitle?: string;
    initialAccess?: SessionInitialAccessDraftV1;
    primaryTeamId?: string | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    directory?: string;
    backendTarget?: BackendTargetRefV2Input;
    startedBy?: 'daemon' | 'terminal';
    terminalRuntime?: TerminalRuntimeFlags | null;
    startingMode?: 'terminal' | 'remote' | 'local';
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    sessionModeId?: string;
    sessionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelectionV1;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    existingSessionId?: string;
    sessionAttachFilePath?: string;
    resume?: string;
    nativeForkSource?: NativeForkSource;
    accountSettingsContext?: AccountSettingsContext | null;
    environmentVariables?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    resolveLateEnvironment?: HostPrivateLateSessionEnvironmentResolver;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStoredCredentials(value: unknown): StoredCredentials | null {
    if (!isRecord(value) || typeof value.token !== 'string' || value.token.length === 0) {
        return null;
    }
    if (value.encryption === null) {
        return {
            token: value.token,
            encryption: null,
        };
    }
    if (!isRecord(value.encryption)) {
        return null;
    }
    if (
        value.encryption.type === 'legacy'
        && value.encryption.secret instanceof Uint8Array
    ) {
        return {
            token: value.token,
            encryption: {
                type: 'legacy',
                secret: value.encryption.secret,
            },
        };
    }
    if (
        value.encryption.type === 'dataKey'
        && value.encryption.publicKey instanceof Uint8Array
        && value.encryption.machineKey instanceof Uint8Array
    ) {
        return {
            token: value.token,
            encryption: {
                type: 'dataKey',
                publicKey: value.encryption.publicKey,
                machineKey: value.encryption.machineKey,
            },
        };
    }
    return null;
}

function readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStartingMode(value: unknown): 'terminal' | 'remote' | 'local' | undefined {
    return value === 'terminal' || value === 'remote' || value === 'local'
        ? value
        : undefined;
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'string'
    );
    return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error('Plugin session unset environment variables must be a string array');
    }
    const entries = normalizeUnsetEnvKeys(value as string[]);
    return entries.length > 0 ? entries : undefined;
}

function readBoundAgentCliLaunchSpec(value: unknown): BoundAgentCliLaunchSpec | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !isRecord(value.spec)) {
        throw new Error('Invalid bound Agent CLI launch');
    }
    const localAgentId = readOptionalString(value.localAgentId);
    const source = value.spec.source;
    const resolvedPath = readOptionalString(value.spec.resolvedPath);
    const command = readOptionalString(value.spec.command);
    const args = value.spec.args;
    if (
        !localAgentId
        || (source !== 'override' && source !== 'system' && source !== 'managed')
        || !resolvedPath
        || !command
        || !Array.isArray(args)
        || args.some((entry) => typeof entry !== 'string')
    ) {
        throw new Error('Invalid bound Agent CLI launch');
    }
    return bindAgentCliLaunchSpec({
        localAgentId,
        spec: { source, resolvedPath, command, args },
    });
}

function readNativeForkSource(value: unknown): NativeForkSource | undefined {
    if (value === undefined) return undefined;
    const parsed = NativeForkSourceSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error('Invalid plugin session native fork source');
    }
    return parsed.data;
}

function readSessionAttachSecret(value: unknown): SessionAttachSecret | undefined {
    if (!isRecord(value)) return undefined;
    if (value.encryptionMode === 'plain') return value as SessionAttachSecret;
    if (
        value.encryptionMode === 'e2ee'
        && value.encryptionKey instanceof Uint8Array
        && (value.encryptionVariant === 'legacy' || value.encryptionVariant === 'dataKey')
    ) return value as SessionAttachSecret;
    return undefined;
}

function readBackendTargetKey(value: unknown): string | null {
    const agentTarget = AgentExecutionTargetV1Schema.safeParse(value);
    if (agentTarget.success) {
        return buildBackendTargetKeyV2(agentTarget.data);
    }
    const parsed = BackendTargetRefV2Schema.safeParse(normalizeBackendTargetRefV2InputToV2(value));
    return parsed.success ? buildBackendTargetKeyV2(parsed.data) : null;
}

function readModelSelection(raw: Record<string, unknown>): SessionModelSelectionV1 | undefined {
    const targetKey = readBackendTargetKey(raw.backendTarget);
    const hasCanonicalModelSelection = raw.modelSelection !== undefined;
    const parsed = SessionModelSelectionV1Schema.safeParse(raw.modelSelection);
    if (parsed.success) {
        if (!targetKey) {
            throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
        }
        if (parsed.data.ref.agentTargetKey !== targetKey) {
            throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
        }
        return parsed.data;
    }
    if (hasCanonicalModelSelection) {
        throw new Error('Invalid plugin session model selection');
    }

    const legacyModelId = readOptionalString(raw.modelId);
    if (!legacyModelId) return undefined;
    if (!targetKey) {
        throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    const ref = resolveSessionModelSelectionInputRefV1({
        agentTargetKey: targetKey,
        providerConnectionId: null,
        modelId: legacyModelId,
    });
    if (ref === null) return undefined;
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: readOptionalNumber(raw.modelUpdatedAt) ?? Date.now(),
        ref,
    });
}

export function buildPluginSessionBindingInput(raw: unknown): PluginSessionBindingInput {
    if (!isRecord(raw)) {
        throw new Error('Plugin session launch params must be an object payload');
    }

    const credentials = readStoredCredentials(raw.credentials);
    if (!credentials) {
        throw new Error('Plugin session launch params must include valid credentials');
    }

    if (
        Object.prototype.hasOwnProperty.call(raw, 'resume')
        && raw.resume !== undefined
        && raw.resume !== null
        && readOptionalString(raw.resume) === undefined
    ) {
        throw new Error('Plugin session runtime requires a non-empty provider continuation id');
    }

    const modelSelection = readModelSelection(raw);
    const agentCliLaunch = readBoundAgentCliLaunchSpec(raw.agentCliLaunch);
    const nativeForkSource = readNativeForkSource(raw.nativeForkSource);
    const initialTitle = readOptionalString(raw.initialTitle);
    const placementOrigin = raw.placementOrigin === undefined
        ? undefined
        : MachinePoolSelectionOriginV1Schema.parse(raw.placementOrigin);
    const initialAccess = raw.initialAccess === undefined
        ? undefined
        : SessionInitialAccessDraftV1Schema.parse(raw.initialAccess);
    const primaryTeamId = SessionSpawnNewInputV2Schema.shape.primaryTeamId.parse(raw.primaryTeamId);
    const teamCredentialBindings = raw.teamCredentialBindings === undefined
        ? undefined
        : SessionTeamCredentialBindingIntentsV1Schema.parse(raw.teamCredentialBindings);
    if (
        (initialAccess !== undefined
            || primaryTeamId !== undefined
            || teamCredentialBindings !== undefined)
        && (readOptionalString(raw.existingSessionId) || readOptionalString(raw.sessionAttachFilePath))
        && !(teamCredentialBindings !== undefined && raw.allowAttachedTeamCredentialBinding === true)
    ) {
        throw new Error('Initial access and Team context require fresh Session creation');
    }
    const parsedSessionCreationTag = raw.sessionCreationTag === undefined
        ? null
        : SessionCreationTagV1Schema.safeParse(raw.sessionCreationTag);
    if (parsedSessionCreationTag !== null && !parsedSessionCreationTag.success) {
        throw new Error('Invalid plugin session creation tag');
    }
    const parsedSessionCreationCorrespondence = raw.sessionCreationCorrespondence === undefined
        ? null
        : SessionCreationCorrespondenceV1Schema.safeParse(raw.sessionCreationCorrespondence);
    if (
        parsedSessionCreationCorrespondence !== null
        && !parsedSessionCreationCorrespondence.success
    ) {
        throw new Error('Invalid plugin session creation correspondence');
    }
    const parsedStartupInstructions = raw.agentSessionStartupInstructionsV1 === undefined
        ? null
        : AgentSessionStartupInstructionsV1Schema.safeParse(
            raw.agentSessionStartupInstructionsV1,
        );
    if (
        parsedStartupInstructions !== null
        && !parsedStartupInstructions.success
    ) {
        throw new Error('Invalid plugin session startup instructions');
    }
    if (nativeForkSource && readOptionalString(raw.resume)) {
        throw new Error('Plugin session native fork source cannot be combined with provider resume');
    }
    if (nativeForkSource && parsedStartupInstructions?.success) {
        throw new Error('Plugin session startup instructions cannot be combined with a native fork');
    }
    const hasConfigurationOptions = raw.sessionConfigOptionOverrides !== undefined;
    const parsedConfigurationOptions = AcpConfigOptionOverridesV1Schema.safeParse(
        raw.sessionConfigOptionOverrides,
    );
    if (hasConfigurationOptions && !parsedConfigurationOptions.success) {
        throw new Error('Invalid plugin session configuration option overrides');
    }

    return Object.freeze({
        credentials,
        ...(agentCliLaunch ? { agentCliLaunch } : {}),
        ...(parsedSessionCreationTag?.success
            ? { sessionCreationTag: parsedSessionCreationTag.data }
            : {}),
        ...(parsedSessionCreationCorrespondence?.success
            ? { sessionCreationCorrespondence: parsedSessionCreationCorrespondence.data }
            : {}),
        ...(initialTitle ? { initialTitle } : {}),
        ...(placementOrigin !== undefined ? { placementOrigin } : {}),
        ...(initialAccess !== undefined ? { initialAccess } : {}),
        ...(primaryTeamId !== undefined ? { primaryTeamId } : {}),
        ...(teamCredentialBindings !== undefined ? { teamCredentialBindings } : {}),
        bootstrap: Object.freeze({
            ...(readOptionalString(raw.directory) ? { workingDirectory: readOptionalString(raw.directory) } : {}),
            ...(isRecord(raw.backendTarget) ? { target: raw.backendTarget as BackendTargetRefV2Input } : {}),
            ...(raw.startedBy === 'daemon' || raw.startedBy === 'terminal'
                ? { source: raw.startedBy }
                : {}),
            ...(raw.accountSettingsContext === null || isRecord(raw.accountSettingsContext)
                ? { accountSettingsContext: raw.accountSettingsContext as AccountSettingsContext | null }
                : {}),
            ...(readStringRecord(raw.environmentVariables)
                ? { environmentVariables: readStringRecord(raw.environmentVariables) }
                : {}),
            ...(readStringArray(raw.unsetEnvironmentVariables)
                ? { unsetEnvironmentVariables: readStringArray(raw.unsetEnvironmentVariables) }
                : {}),
            ...(typeof raw.resolveLateEnvironment === 'function'
                ? {
                    resolveLateEnvironment:
                        raw.resolveLateEnvironment as HostPrivateLateSessionEnvironmentResolver,
                }
                : {}),
        }),
        resume: Object.freeze({
            ...(readOptionalString(raw.existingSessionId) ? { existingSessionId: readOptionalString(raw.existingSessionId) } : {}),
            ...(readOptionalString(raw.sessionAttachFilePath) ? { sessionAttachFilePath: readOptionalString(raw.sessionAttachFilePath) } : {}),
            ...(readSessionAttachSecret(raw.sessionAttachSecret)
                ? { sessionAttachSecret: readSessionAttachSecret(raw.sessionAttachSecret)! }
                : {}),
            // Agent-issued and opaque: carried without renormalization.
            ...(readNonBlankOpaqueIdentifier(raw.resume)
                ? { resumeSessionId: readNonBlankOpaqueIdentifier(raw.resume)! }
                : {}),
        }),
        ...(nativeForkSource ? { nativeForkSource } : {}),
        ...(parsedStartupInstructions?.success
            ? { agentSessionStartupInstructionsV1: parsedStartupInstructions.data }
            : {}),
        runtimePreferences: Object.freeze({
            ...(raw.terminalRuntime === null || isRecord(raw.terminalRuntime)
                ? { terminal: raw.terminalRuntime as TerminalRuntimeFlags | null }
                : {}),
            ...(readStartingMode(raw.startingMode)
                ? { startingMode: readStartingMode(raw.startingMode) }
                : {}),
            ...(readOptionalString(raw.permissionMode)
                ? {
                    permission: Object.freeze({
                        mode: readOptionalString(raw.permissionMode)! as PermissionMode,
                        ...(readOptionalNumber(raw.permissionModeUpdatedAt) !== undefined
                            ? { updatedAt: readOptionalNumber(raw.permissionModeUpdatedAt) }
                            : {}),
                    }),
                }
                : {}),
            ...(readOptionalString(raw.sessionModeId)
                ? {
                    sessionMode: Object.freeze({
                        id: readOptionalString(raw.sessionModeId)!,
                        ...(readOptionalNumber(raw.sessionModeUpdatedAt) !== undefined
                            ? { updatedAt: readOptionalNumber(raw.sessionModeUpdatedAt) }
                            : {}),
                    }),
                }
                : {}),
            ...(modelSelection ? { modelSelection } : {}),
            ...(parsedConfigurationOptions.success
                ? { configurationOptions: parsedConfigurationOptions.data }
                : {}),
        }),
    });
}

export function buildPluginHostSessionRuntimeOptions(
    input: PluginSessionBindingInput,
): PluginHostSessionRuntimeOptions {
    return Object.freeze({
        credentials: input.credentials,
        ...(input.agentSessionStartupInstructionsV1
            ? { agentSessionStartupInstructionsV1: input.agentSessionStartupInstructionsV1 }
            : {}),
        ...(input.sessionCreationTag
            ? { sessionCreationTag: input.sessionCreationTag }
            : {}),
        ...(input.sessionCreationCorrespondence
            ? { sessionCreationCorrespondence: input.sessionCreationCorrespondence }
            : {}),
        ...(input.initialTitle ? { initialTitle: input.initialTitle } : {}),
        ...(input.placementOrigin !== undefined ? { placementOrigin: input.placementOrigin } : {}),
        ...(input.initialAccess !== undefined ? { initialAccess: input.initialAccess } : {}),
        ...(input.primaryTeamId !== undefined ? { primaryTeamId: input.primaryTeamId } : {}),
        ...(input.teamCredentialBindings !== undefined
            ? { teamCredentialBindings: input.teamCredentialBindings }
            : {}),
        ...(typeof input.bootstrap.workingDirectory === 'string' ? { directory: input.bootstrap.workingDirectory } : {}),
        ...(input.bootstrap.target ? { backendTarget: input.bootstrap.target } : {}),
        ...(input.bootstrap.source ? { startedBy: input.bootstrap.source } : {}),
        ...(input.bootstrap.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.bootstrap.runtimeDescriptorV1 } : {}),
        ...(input.runtimePreferences.terminal !== undefined ? { terminalRuntime: input.runtimePreferences.terminal } : {}),
        ...(input.runtimePreferences.startingMode ? { startingMode: input.runtimePreferences.startingMode } : {}),
        ...(input.runtimePreferences.permission?.mode ? { permissionMode: input.runtimePreferences.permission.mode } : {}),
        ...(typeof input.runtimePreferences.permission?.updatedAt === 'number'
            ? { permissionModeUpdatedAt: input.runtimePreferences.permission.updatedAt }
            : {}),
        ...(input.runtimePreferences.sessionMode?.id ? { sessionModeId: input.runtimePreferences.sessionMode.id } : {}),
        ...(typeof input.runtimePreferences.sessionMode?.updatedAt === 'number'
            ? { sessionModeUpdatedAt: input.runtimePreferences.sessionMode.updatedAt }
            : {}),
        ...(input.runtimePreferences.modelSelection
            ? { modelSelection: input.runtimePreferences.modelSelection }
            : {}),
        ...(input.runtimePreferences.configurationOptions
            ? { sessionConfigOptionOverrides: input.runtimePreferences.configurationOptions }
            : {}),
        ...(input.resume.existingSessionId ? { existingSessionId: input.resume.existingSessionId } : {}),
        ...(input.resume.sessionAttachFilePath ? { sessionAttachFilePath: input.resume.sessionAttachFilePath } : {}),
        ...(input.resume.sessionAttachSecret ? { sessionAttachSecret: input.resume.sessionAttachSecret } : {}),
        ...(input.resume.resumeSessionId ? { resume: input.resume.resumeSessionId } : {}),
        ...(input.bootstrap.accountSettingsContext !== undefined
            ? { accountSettingsContext: input.bootstrap.accountSettingsContext }
            : {}),
        ...(input.bootstrap.environmentVariables
            ? { environmentVariables: { ...input.bootstrap.environmentVariables } }
            : {}),
        ...(input.bootstrap.unsetEnvironmentVariables
            ? { unsetEnvironmentVariables: [...input.bootstrap.unsetEnvironmentVariables] }
            : {}),
        ...(input.bootstrap.resolveLateEnvironment
            ? {
                resolveLateEnvironment:
                    input.bootstrap.resolveLateEnvironment,
            }
            : {}),
    });
}
