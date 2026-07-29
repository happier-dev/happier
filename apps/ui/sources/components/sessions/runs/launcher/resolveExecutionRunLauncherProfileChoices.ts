import type { ExecutionRunProfileCapability } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';

export type ExecutionRunLauncherProfileChoice = ExecutionRunProfileCapability & Readonly<{
    compatibleAgentId: string | null;
    disabled: boolean;
}>;

export function doesExecutionRunProfileMatchSelectedBackends(
    profile: Pick<ExecutionRunProfileCapability, 'compatibleAgentIds'>,
    selectedBackendIds: readonly string[],
): boolean {
    return selectedBackendIds.length === 1 && profile.compatibleAgentIds.includes(selectedBackendIds[0]!);
}

export function resolveExecutionRunLauncherProfileChoices(params: Readonly<{
    intent: string;
    profiles: readonly ExecutionRunProfileCapability[];
    backendChoices: readonly Readonly<{ backendId: string; disabled: boolean }>[];
}>): readonly ExecutionRunLauncherProfileChoice[] {
    return Object.freeze(params.profiles
        .filter((profile) => profile.intent === params.intent)
        .map((profile) => {
            const compatibleBackend = params.backendChoices.find((backend) => (
                backend.disabled !== true && profile.compatibleAgentIds.includes(backend.backendId)
            ));
            return Object.freeze({
                ...profile,
                compatibleAgentId: compatibleBackend?.backendId ?? null,
                disabled: profile.available !== true || !compatibleBackend,
            });
        }));
}
