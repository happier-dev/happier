import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserContextDispatchRequestV1Schema, DaemonBrowserContextDispatchResponseV1Schema } from '@happier-dev/protocol/browser/context/v1';
import type { DaemonBrowserContextDispatchResponseV1 } from '@happier-dev/protocol/browser/context/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createBrowserRawRequestAdmission } from './daemonBrowserRequestAdmission';

export type DaemonBrowserContextHandlerOptions = Readonly<{
    browserContext?: BrowserContextRoutes | null;
    resolveBrowserControl?: () => BrowserDaemonControlRoutes | null | undefined;
}>;

export function registerDaemonBrowserContextHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserContextHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
        async (raw: unknown, context): Promise<DaemonBrowserContextDispatchResponseV1> => {
            const request = DaemonBrowserContextDispatchRequestV1Schema.parse(raw);
            if (!options.browserContext) {
                throw new Error('Browser context runtime is unavailable');
            }
            const parsed = getActionSpec(request.actionId).inputSchema.safeParse(request.input);
            const normalized = parsed.success ? parsed.data : request.input;
            if (parsed.success) createBrowserRawRequestAdmission(options.resolveBrowserControl, context)
                .requireContext(options.browserContext, request.actionId, normalized);
            const result = await options.browserContext.dispatch(request.actionId, normalized);
            return DaemonBrowserContextDispatchResponseV1Schema.parse({
                protocolVersion: 1,
                result,
            });
        },
    );
}
