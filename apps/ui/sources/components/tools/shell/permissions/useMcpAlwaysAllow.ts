import * as React from 'react';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { supportsSessionPermissionPersistence } from '@/sync/ops/sessionPermissionAnswers';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createRequestOwnedActionExecution } from '@/components/approvals/requestOwnedActionExecution';
import { createRequestOwnedControllerStore } from '@/components/approvals/requestOwnedControllerStore';
import { createMcpAlwaysAllowController, type McpAlwaysAllowSnapshot } from './mcpAlwaysAllow';

type McpAlwaysAllowController = ReturnType<typeof createMcpAlwaysAllowController>;
type McpAlwaysAllowInput = Readonly<{
    requestId: string; turnId?: string; source?: string; identity: ResolvedMcpToolIdentityV1;
    scope: ServerAccountScope | null; canWriteCatalog: boolean; answerForSession(): Promise<void>;
}>;
type MountedView = React.RefObject<{ input: McpAlwaysAllowInput; key: string; execution: ReturnType<typeof useMountedActionExecution> }>;
const idle: McpAlwaysAllowSnapshot = { status: 'idle', answered: false, errorCode: null };
/**
 * One Always allow per request: the attention tray and the transcript row both draw this footer, and the tray's
 * copy leaves as soon as the request is answered. The answer runs through the latest mounted view; the catalog
 * save is owned by the request (its Account's Home executor, like the enable request's Always), so it completes
 * after the card leaves and any view that remains shows "saved" or "Couldn't save · Try again".
 */
const sharedControllers = createRequestOwnedControllerStore<McpAlwaysAllowController, MountedView, McpAlwaysAllowSnapshot>({
    create(readView, receipt) {
        const current = readView()!.current;
        const key = current.key;
        return createMcpAlwaysAllowController({ identity: current.input.identity,
            answerForSession: () => {
                const view = readView()?.current;
                return view?.key === key ? view.input.answerForSession() : Promise.reject(new Error('scope-retired'));
            },
            execute: createRequestOwnedActionExecution(current.input.scope),
        }, receipt ?? undefined);
    },
    subscribe: (controller, listener) => controller.subscribe(listener),
    checkpoint: controller => controller.getSnapshot().answered ? controller.getSnapshot() : null,
});

/** Mounted by the existing permission footer; its answer callback is answerThroughSession('allowForSession'). */
export function useMcpAlwaysAllow(input: McpAlwaysAllowInput) {
    const execution = useMountedActionExecution(input.scope);
    const key = JSON.stringify([input.scope?.serverId, input.scope?.accountId, execution.binding?.revision, input.requestId, input.turnId, input.source, input.identity.item.serverId, input.identity.tool]);
    const latest = React.useRef({ input, execution, key }); latest.current = { input, execution, key };
    const subscribe = React.useCallback((listener: () => void) => sharedControllers.subscribe(key, latest, listener), [key]);
    const read = React.useCallback(() => sharedControllers.get(key)?.getSnapshot() ?? sharedControllers.getReceipt(key) ?? idle, [key]);
    const state = React.useSyncExternalStore(subscribe, read, read);
    const available = input.canWriteCatalog && execution.ready && input.identity.server !== 'happier' && supportsSessionPermissionPersistence(input.source);
    const allow = React.useCallback(async () => {
        if (latest.current.key !== key || !latest.current.input.canWriteCatalog || !latest.current.execution.isCurrent()
            || latest.current.input.identity.server === 'happier' || !supportsSessionPermissionPersistence(latest.current.input.source)) return;
        await sharedControllers.run(key, controller => controller.allow());
    }, [key]);
    return { ...state, available, allow, retrySave: allow };
}
