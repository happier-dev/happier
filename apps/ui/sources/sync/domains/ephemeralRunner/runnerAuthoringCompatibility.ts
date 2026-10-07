import { LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1 } from '@happier-dev/protocol/profiles/v2/schema';
import type { SessionAuthoringFieldId } from '@happier-dev/protocol/sessions/authoring/index';
// Deep import: this owner is consumed by the picker and composer chips, which
// must not pull the whole Protocol barrel to answer one portability question.
import { classifyRunnerConnectedServiceSelectionV1 } from '@happier-dev/protocol/ephemeralRunner/runnerConnectedServices';
import { isRunnerIsolationEnvironmentKeyV1 } from '@happier-dev/protocol/ephemeralRunner/runnerEnvironment';

export type RunnerUnsupportedAuthoringField =
    | 'connectedServices'
    | 'transcriptStorage'
    | 'environmentVariables'
    | 'windowsRemoteSessionLaunchMode'
    | 'windowsRemoteSessionConsole'
    | 'windowsTerminalWindowName'
    | 'runtimeDescriptorV1'
    | 'automation';

/**
 * Reads only the canonical authoring field ids, so any ordinary authoring draft
 * can be passed without a second projection that could drop a field.
 */
export type RunnerAuthoringCompatibilityInput =
    Readonly<Partial<Record<SessionAuthoringFieldId, unknown>>>;

/**
 * True when at least one selected Connected Service stays bound to an owner a
 * fresh computer cannot reach. The portability rule itself belongs to the
 * Protocol Runner owner that the sealed launch manifest and creator custody
 * already consume; this only reads the current selection through it.
 */
function hasUnportableConnectedServiceSelection(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const bindingsByServiceId = (value as { bindingsByServiceId?: unknown }).bindingsByServiceId;
    if (!bindingsByServiceId || typeof bindingsByServiceId !== 'object') return false;
    return Object.values(bindingsByServiceId as Record<string, unknown>).some((selection) => {
        if (!selection || typeof selection !== 'object') return false;
        const source = (selection as { source?: unknown }).source;
        return typeof source === 'string'
            && classifyRunnerConnectedServiceSelectionV1({ source }) === 'not_portable';
    });
}

function hasRunnerIsolationEnvironmentOverride(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).some(isRunnerIsolationEnvironmentKeyV1);
}

/**
 * Provider routing/auth environment stays owned by Lane 10's exact broker.
 * The global reserved set is the incumbent Profile owner; the selected Agent
 * contribution may extend it for provider-specific runtime variables. Env
 * identities are folded only for this check because Windows treats them case
 * insensitively.
 */
export function isRunnerProviderOwnedEnvironmentKey(input: Readonly<{
    name: string;
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[];
}>): boolean {
    const identity = input.name.toUpperCase();
    return LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1.has(identity)
        || input.selectedAgentProviderOwnedEnvironmentKeys.some((name) => name.toUpperCase() === identity);
}

function hasRunnerProviderOwnedEnvironmentOverride(
    value: unknown,
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[],
): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).some((name) => isRunnerProviderOwnedEnvironmentKey({
        name,
        selectedAgentProviderOwnedEnvironmentKeys,
    }));
}

/**
 * Finds explicit ordinary-session selections that Runner cannot materialize
 * without importing Account-owned settings or credentials. MCP selection is
 * handled separately by the canonical portable resolution/materialization path.
 *
 * This runs before an activation exists. The strict launch manifest rejects the
 * same selections later, but by then the package has been assembled, exported
 * and possibly claimed, so a late rejection is not a usable explanation.
 */
export function findRunnerUnsupportedAuthoringField(
    authoring: RunnerAuthoringCompatibilityInput,
    selectedAgentProviderOwnedEnvironmentKeys: readonly string[] = [],
): RunnerUnsupportedAuthoringField | null {
    if (hasUnportableConnectedServiceSelection(authoring.connectedServices)) return 'connectedServices';
    if (authoring.transcriptStorage === 'direct') return 'transcriptStorage';
    if (hasRunnerIsolationEnvironmentOverride(authoring.environmentVariables)) return 'environmentVariables';
    if (hasRunnerProviderOwnedEnvironmentOverride(
        authoring.environmentVariables,
        selectedAgentProviderOwnedEnvironmentKeys,
    )) return 'environmentVariables';

    for (const field of [
        'windowsRemoteSessionLaunchMode',
        'windowsRemoteSessionConsole',
        'windowsTerminalWindowName',
        'runtimeDescriptorV1',
        'automation',
    ] as const) {
        if (authoring[field] !== null && authoring[field] !== undefined) return field;
    }

    return null;
}
