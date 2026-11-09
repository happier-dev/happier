import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useExecutionRunsBackendsForMachine } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useInputFieldOptions, type InputFieldOptionsRequest } from './useInputFieldOptions';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';

/** Machine-targeted forms resolve declared fields only while their owning surface demands them. */
export function useActionFieldOptionsForMachine(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    enabled: boolean;
    requests: readonly InputFieldOptionsRequest[];
}>): ResolveSessionActionFieldOptions {
    const enabledAgentIds = useEnabledAgentIds();
    const backends = useExecutionRunsBackendsForMachine({ ...params, enabled: params.enabled && params.requests.length > 0 });
    return useInputFieldOptions({ ...params, refreshKey: JSON.stringify([enabledAgentIds, backends]) }).resolveOptions;
}

