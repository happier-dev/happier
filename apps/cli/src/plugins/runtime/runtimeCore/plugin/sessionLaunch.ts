import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { ProviderAcceptancePendingMaterializationPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
import { normalizeProviderAcceptancePendingMaterializationPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type { PluginSessionLaunchResultCandidate } from './sessionMetadata';

export type PluginSessionBindingInput = Readonly<{
    credentials: Credentials;
    bootstrap: Readonly<{
        workingDirectory?: string;
        target?: BackendTargetRefV2Input;
        source?: 'daemon' | 'terminal';
        accountSettingsContext?: AccountSettingsContext | null;
        environmentVariables?: Readonly<Record<string, string>>;
    }>;
    resume: Readonly<{
        existingSessionId?: string;
        resumeSessionId?: string;
    }>;
    runtimePreferences: Readonly<{
        terminal?: TerminalRuntimeFlags | null;
        permission?: Readonly<{
            mode: PermissionMode;
            updatedAt?: number;
        }>;
        sessionMode?: Readonly<{
            id: string;
            updatedAt?: number;
        }>;
        model?: Readonly<{
            id: string;
            updatedAt?: number;
        }>;
        providerAcceptancePendingMaterialization?: ProviderAcceptancePendingMaterializationPolicy;
    }>;
}>;

export type PluginSessionLaunchParams = Readonly<{
    backend: Readonly<{
        id: string;
        providerId: string;
    }>;
    sessionId: string;
    directory: string;
    metadata: Readonly<Record<string, unknown>>;
}> & PluginSessionBindingInput;

export type PluginSessionLaunchHandler = (
    params: PluginSessionLaunchParams,
) => Promise<PluginSessionLaunchResultCandidate>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'string'
    );
    return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

function readProviderAcceptancePendingMaterialization(
    value: unknown,
): ProviderAcceptancePendingMaterializationPolicy | undefined {
    return value === 'claimUntilProviderAccept' || value === 'commitAtMaterialize'
        ? normalizeProviderAcceptancePendingMaterializationPolicy(value)
        : undefined;
}

export function buildPluginSessionBindingInput(raw: unknown): PluginSessionBindingInput {
    if (!isRecord(raw)) {
        throw new Error('Plugin session launch params must be an object payload');
    }

    const credentials = raw.credentials as Credentials | undefined;
    if (!credentials) {
        throw new Error('Plugin session launch params must include credentials');
    }

    const providerAcceptancePendingMaterialization = readProviderAcceptancePendingMaterialization(
        raw.providerAcceptancePendingMaterialization,
    );

    return Object.freeze({
        credentials,
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
        }),
        resume: Object.freeze({
            ...(readOptionalString(raw.existingSessionId) ? { existingSessionId: readOptionalString(raw.existingSessionId) } : {}),
            ...(readOptionalString(raw.resume) ? { resumeSessionId: readOptionalString(raw.resume) } : {}),
        }),
        runtimePreferences: Object.freeze({
            ...(raw.terminalRuntime === null || isRecord(raw.terminalRuntime)
                ? { terminal: raw.terminalRuntime as TerminalRuntimeFlags | null }
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
            ...(readOptionalString(raw.modelId)
                ? {
                    model: Object.freeze({
                        id: readOptionalString(raw.modelId)!,
                        ...(readOptionalNumber(raw.modelUpdatedAt) !== undefined
                            ? { updatedAt: readOptionalNumber(raw.modelUpdatedAt) }
                            : {}),
                    }),
                }
                : {}),
            ...(providerAcceptancePendingMaterialization
                ? {
                    providerAcceptancePendingMaterialization,
                }
                : {}),
        }),
    });
}

export function buildPluginSessionLaunchParams(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    input: PluginSessionBindingInput;
    runtime: Readonly<{
        sessionId: string;
        directory: string;
        metadata: Readonly<Record<string, unknown>>;
    }>;
}>): PluginSessionLaunchParams {
    return Object.freeze({
        backend: Object.freeze({
            id: params.backend.id,
            providerId: params.provider.id,
        }),
        sessionId: params.runtime.sessionId,
        directory: params.runtime.directory,
        metadata: params.runtime.metadata,
        ...params.input,
    });
}

export function buildPluginHostSessionRuntimeOptions(
    input: PluginSessionBindingInput,
) {
    return Object.freeze({
        credentials: input.credentials,
        ...(typeof input.bootstrap.workingDirectory === 'string' ? { directory: input.bootstrap.workingDirectory } : {}),
        ...(input.bootstrap.target ? { backendTarget: input.bootstrap.target } : {}),
        ...(input.bootstrap.source ? { startedBy: input.bootstrap.source } : {}),
        ...(input.runtimePreferences.terminal !== undefined ? { terminalRuntime: input.runtimePreferences.terminal } : {}),
        ...(input.runtimePreferences.permission?.mode ? { permissionMode: input.runtimePreferences.permission.mode } : {}),
        ...(typeof input.runtimePreferences.permission?.updatedAt === 'number'
            ? { permissionModeUpdatedAt: input.runtimePreferences.permission.updatedAt }
            : {}),
        ...(input.runtimePreferences.sessionMode?.id ? { sessionModeId: input.runtimePreferences.sessionMode.id } : {}),
        ...(typeof input.runtimePreferences.sessionMode?.updatedAt === 'number'
            ? { sessionModeUpdatedAt: input.runtimePreferences.sessionMode.updatedAt }
            : {}),
        ...(input.runtimePreferences.model?.id ? { modelId: input.runtimePreferences.model.id } : {}),
        ...(typeof input.runtimePreferences.model?.updatedAt === 'number'
            ? { modelUpdatedAt: input.runtimePreferences.model.updatedAt }
            : {}),
        ...(input.resume.existingSessionId ? { existingSessionId: input.resume.existingSessionId } : {}),
        ...(input.resume.resumeSessionId ? { resume: input.resume.resumeSessionId } : {}),
        ...(input.bootstrap.accountSettingsContext !== undefined
            ? { accountSettingsContext: input.bootstrap.accountSettingsContext }
            : {}),
        ...(input.bootstrap.environmentVariables
            ? { environmentVariables: { ...input.bootstrap.environmentVariables } }
            : {}),
    });
}
