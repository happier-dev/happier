import type { Href } from '@/components/appShell/workspace/destinationRoute';

/**
 * Where a FIN trigger set is edited: a session's triggers live in that session's Work tab, a saved
 * workflow's on the workflow, and Account inline triggers in the Workflows column. One place decides,
 * for every surface that links to a trigger it does not edit itself.
 */
export function resolveTriggerEditorHref(input: Readonly<{
    automationId: string;
    serverId: string;
    scopeSessionId?: string | null;
    workflowDefinitionId?: string | null;
}>): Href {
    if (input.scopeSessionId) {
        return { pathname: '/session/[id]/triggers', params: { id: input.scopeSessionId, serverId: input.serverId, trigger: input.automationId } };
    }
    if (input.workflowDefinitionId) {
        return { pathname: '/workflows/[id]', params: { id: input.workflowDefinitionId, intent: 'schedule' } };
    }
    return { pathname: '/workflows', params: { trigger: input.automationId } };
}
