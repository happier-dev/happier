export type TriggerEditorHref =
    | Readonly<{ pathname: '/session/[id]/triggers'; params: Readonly<{ id: string; serverId: string; trigger?: string }> }>
    | Readonly<{ pathname: '/workflows/[id]'; params: Readonly<{ id: string; intent: 'schedule'; serverId: string }> }>
    | Readonly<{ pathname: '/workflows'; params: Readonly<{ serverId: string; trigger?: string }> }>;

/**
 * Where a FIN trigger set is edited: a session's triggers live in that session's Work tab, a saved
 * workflow's on the workflow, and Account inline triggers in the Workflows column. One place decides,
 * for every surface that links to a trigger it does not edit itself.
 */
export function resolveTriggerEditorHref(input: Readonly<{
    automationId?: string;
    serverId: string;
    scopeSessionId?: string | null;
    workflowDefinitionId?: string | null;
}>): TriggerEditorHref {
    if (input.scopeSessionId) {
        return { pathname: '/session/[id]/triggers', params: { id: input.scopeSessionId, serverId: input.serverId,
            ...(input.automationId ? { trigger: input.automationId } : {}) } };
    }
    if (input.workflowDefinitionId) {
        return { pathname: '/workflows/[id]', params: { id: input.workflowDefinitionId, intent: 'schedule', serverId: input.serverId } };
    }
    return { pathname: '/workflows', params: { serverId: input.serverId, ...(input.automationId ? { trigger: input.automationId } : {}) } };
}
