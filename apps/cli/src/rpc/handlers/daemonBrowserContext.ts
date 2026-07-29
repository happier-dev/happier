import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonBrowserContextDispatchRequestV1Schema,
    DaemonBrowserContextDispatchResponseV1Schema,
    type DaemonBrowserContextDispatchResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';

export type DaemonBrowserContextHandlerOptions = Readonly<{
    browserContext?: BrowserContextRoutes | null;
}>;

export function registerDaemonBrowserContextHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserContextHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
        async (raw: unknown): Promise<DaemonBrowserContextDispatchResponseV1> => {
            const request = DaemonBrowserContextDispatchRequestV1Schema.parse(raw);
            if (!options.browserContext) {
                throw new Error('Browser context runtime is unavailable');
            }
            const result = await options.browserContext.dispatch(request.actionId, request.input);
            return DaemonBrowserContextDispatchResponseV1Schema.parse({
                protocolVersion: 1,
                result,
            });
        },
    );
}
