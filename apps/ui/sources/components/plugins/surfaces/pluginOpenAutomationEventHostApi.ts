import { router } from 'expo-router';
import { PluginUiOpenAutomationEventRequestV1Schema, type PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { storeAutomationEventAuthoringSeed } from '@/sync/domains/workflows/automationEventAuthoringSeed';
import { consumeWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler, type PluginSurfaceHostApiRequestOptions } from './createPluginSurfaceHostApi';

type AutomationEventRoute = Readonly<{ pathname: '/workflows'; params: Readonly<{ automationEventSeedId: string; serverId: string }> }>;

/** The host opens intent only; the existing Event and trigger owners retain every write. */
export function createPluginOpenAutomationEventHandler(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
    lifetimeSignal?: AbortSignal;
    navigate?: (route: AutomationEventRoute) => void;
}>) {
    return async (payload: unknown, options?: PluginSurfaceHostApiRequestOptions): Promise<PluginUiJsonValueV1> => {
        const parsed = PluginUiOpenAutomationEventRequestV1Schema.safeParse(payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['automation_event_seed_invalid']);
        if (!input.isCurrent() || !input.accountLifetime.isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
        if (!areServerAccountScopesEqual(input.accountLifetime.scope, getActiveServerAccountScope())) {
            return createPluginSurfaceHostApiError('unavailable', ['automation_event_active_account_required']);
        }
        if (input.lifetimeSignal?.aborted || options?.signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['automation_event_open_aborted']);
        const seedId = storeAutomationEventAuthoringSeed(parsed.data, input.accountLifetime);
        try {
            (input.navigate ?? ((route) => router.push(route)))({ pathname: '/workflows', params: {
                automationEventSeedId: seedId, serverId: input.accountLifetime.scope.serverId,
            } });
            return null;
        } catch {
            consumeWorkflowEditorDraftSeed(seedId);
            return createPluginSurfaceHostApiError('unavailable', ['automation_event_navigation_unavailable']);
        }
    };
}

export function createPluginOpenAutomationEventHostApiHandler(input: Parameters<typeof createPluginOpenAutomationEventHandler>[0]): PluginSurfaceHostApiMethodHandler {
    const open = createPluginOpenAutomationEventHandler(input);
    return (request, options) => request.method === 'openAutomationEvent' ? open(request.payload, options)
        : createPluginSurfaceHostApiError('unsupported_method');
}
