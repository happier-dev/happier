import type { PermissionMode } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import {
  AcpConfigOptionOverridesV1Schema,
    AgentSessionStartupInstructionsV1Schema,
    BackendTargetRefV2Schema,
    buildBackendTargetKeyV2,
    normalizeBackendTargetRefV2InputToV2,
    resolveSessionModelSelectionInputRefV1,
    SessionModelSelectionResolutionError,
    SessionModelSelectionV1Schema,
    SessionCreationCorrespondenceV1Schema,
    SessionCreationTagV1Schema,
    type BackendTargetRefV2Input,
    type AcpConfigOptionOverridesV1,
    type AgentSessionStartupInstructionsV1,
    type SessionCreationCorrespondenceV1,
    type SessionCreationTagV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import type { PluginSessionLaunchResultCandidate } from './sessionMetadata';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import {
  NativeForkSourceSchema,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';

export type PluginSessionBindingInput = Readonly<{
    credentials: StoredCredentials;
    sessionCreationTag?: SessionCreationTagV1;
    sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
    initialTitle?: string;
    bootstrap: Readonly<{
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

export type PluginSessionLaunchParams = Readonly<{
    backend: Readonly<{
        id: string;
        agentId: string;
    }>;
    sessionId: string;
    directory: string;
    metadata: Readonly<Record<string, unknown>>;
}> & Omit<
    PluginSessionBindingInput,
    'sessionCreationTag' | 'sessionCreationCorrespondence' | 'initialTitle'
>;

export type PluginSessionLaunchHandler = (
    params: PluginSessionLaunchParams,
) => Promise<PluginSessionLaunchResultCandidate>;

export type PluginHostSessionRuntimeOptions = Readonly<{
    credentials: StoredCredentials;
    sessionCreationTag?: SessionCreationTagV1;
    sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
    initialTitle?: string;
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

function readNativeForkSource(value: unknown): NativeForkSource | undefined {
    if (value === undefined) return undefined;
    const parsed = NativeForkSourceSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error('Invalid plugin session native fork source');
    }
    return parsed.data;
}

function readBackendTargetKey(value: unknown): string | null {
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
    const nativeForkSource = readNativeForkSource(raw.nativeForkSource);
    const initialTitle = readOptionalString(raw.initialTitle);
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
        ...(parsedSessionCreationTag?.success
            ? { sessionCreationTag: parsedSessionCreationTag.data }
            : {}),
        ...(parsedSessionCreationCorrespondence?.success
            ? { sessionCreationCorrespondence: parsedSessionCreationCorrespondence.data }
            : {}),
        ...(initialTitle ? { initialTitle } : {}),
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
            ...(readOptionalString(raw.resume) ? { resumeSessionId: readOptionalString(raw.resume) } : {}),
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

export function buildPluginSessionLaunchParams(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    input: PluginSessionBindingInput;
    runtime: Readonly<{
        sessionId: string;
        directory: string;
        metadata: Readonly<Record<string, unknown>>;
    }>;
}>): PluginSessionLaunchParams {
    const {
        sessionCreationTag: _sessionCreationTag,
        sessionCreationCorrespondence: _sessionCreationCorrespondence,
        initialTitle: _initialTitle,
        ...launchInput
    } = params.input;
    return Object.freeze({
        backend: Object.freeze({
            id: params.backend.id,
            agentId: params.agent.id,
        }),
        sessionId: params.runtime.sessionId,
        directory: params.runtime.directory,
        metadata: params.runtime.metadata,
        ...launchInput,
    });
}

export function buildPluginHostSessionRuntimeOptions(
    input: PluginSessionBindingInput,
): PluginHostSessionRuntimeOptions {
    return Object.freeze({
        credentials: input.credentials,
        ...(input.sessionCreationTag
            ? { sessionCreationTag: input.sessionCreationTag }
            : {}),
        ...(input.sessionCreationCorrespondence
            ? { sessionCreationCorrespondence: input.sessionCreationCorrespondence }
            : {}),
        ...(input.initialTitle ? { initialTitle: input.initialTitle } : {}),
        ...(typeof input.bootstrap.workingDirectory === 'string' ? { directory: input.bootstrap.workingDirectory } : {}),
        ...(input.bootstrap.target ? { backendTarget: input.bootstrap.target } : {}),
        ...(input.bootstrap.source ? { startedBy: input.bootstrap.source } : {}),
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
