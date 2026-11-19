import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserControlDispatchRequestV1Schema, DaemonBrowserControlDispatchResponseV1Schema, DaemonBrowserViewListRequestV1Schema, DaemonBrowserViewListResponseV1Schema, DaemonBrowserViewWatchRequestV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { DaemonBrowserControlDispatchResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createBrowserProfilePasskeyImporter } from '@/daemon/browser/profiles/importPasskeys';
import { createBrowserProfileCookieImporter } from '@/daemon/browser/profiles/importCookies';
import type { ReverseCaptureMachineRpcClient } from '@/daemon/browser/recording/reverseChannel/desktopReverseCaptureUiCall';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserDaemonViewDiscovery } from '@/daemon/browser/control/viewDiscovery';
import { browserCommandDispatchFailure, browserCommandScope } from '@/daemon/browser/control/types';
import { resolveManagedBrowserSidecarCandidate } from '@/daemon/browser/sidecar/source';
import { listBrowserCookieSources, readBrowserCookieSource } from '@/daemon/browser/profiles/cookieSources';
import { BrowserCookieSourceReadV1Schema, BrowserCookieSourceResultV1Schema, BrowserCookieApplyV1Schema,
    BrowserPasskeysApplyV1Schema, BrowserLoginSourcesResultV1Schema, BrowserProfileLoginsImportResultV1Schema } from '@happier-dev/protocol/browser/profile/v1';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';

async function unavailableBrowserControl(): Promise<never> {
    // Explain the absent owner through the same source that startup/provisioning uses. Discovery
    // remains read-only: only an admitted Browser open/automation Action may start the download.
    const candidate = await resolveManagedBrowserSidecarCandidate();
    if (candidate?.available === false) {
        throw new RpcError(
            'Managed Chromium is not installed on this machine. Open a Browser view to download it, then try again.',
            'managed_package_missing',
        );
    }
    // An installed or unsupported source does not establish why no route was registered.
    throw new RpcError('Browser control runtime is unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

// W2-A-1 / A3: expose the existing `createBrowserDaemonControlRoutes` broker as a UI-reachable
// machine-scoped RPC. The human-owner control surface (streamed/sidecar view reload/stop/navigate)
// supplies a real `sendDaemonCommand` transport that routes a `BrowserCommandV1` here, through the
// SAME control broker the agent execution-run dispatch uses (MC-6 — one daemon control owner, no
// parallel path). The route is owner-scoped (account+machine, direct_ephemeral) — the user-initiated
// UI and automation callers retain verified ingress authority and request cancellation;
// control and confidentiality decisions stay with the shared Browser owner.
export type DaemonBrowserControlHandlerOptions = Readonly<{
    browserControl?: BrowserDaemonControlRoutes | null;
    getNativeClient?: () => ReverseCaptureMachineRpcClient | null | undefined;
}>;

/** Registered before the optional Chromium runtime exists, through the same Machine transport. */
export function registerDaemonBrowserViewWatchHandler(rpc: RpcHandlerRegistrar, discovery: BrowserDaemonViewDiscovery): void {
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH, async (raw: unknown, context?: RpcHandlerContext) => {
        const request = DaemonBrowserViewWatchRequestV1Schema.parse(raw);
        const views = await discovery.watchViews({ browserSessionId: request.browserSessionId,
            knownViewIds: request.knownViewIds, signal: context?.signal,
            scope: browserCommandScope(buildActionExecutorContextForRpc(context ?? {})) });
        return DaemonBrowserViewListResponseV1Schema.parse({ protocolVersion: 1, views,
            ...(context?.authorization?.kind === 'session.browser' ? { machineId: context.authorization.machineId } : {}) });
    });
}

export function registerDaemonBrowserControlHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserControlHandlerOptions = {},
): void {
    const importCookies = options.browserControl?.importCookies
        ?? createBrowserProfileCookieImporter(undefined, options.getNativeClient ? { getNativeClient: options.getNativeClient } : undefined);
    const importNativePasskeys = createBrowserProfilePasskeyImporter(undefined, { getNativeClient: options.getNativeClient });
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY, async (raw: unknown, context?: RpcHandlerContext) => {
        const request = BrowserPasskeysApplyV1Schema.safeParse(raw);
        if (!request.success) return { status: 'unavailable', code: 'source_format_unsupported' };
        return BrowserProfileLoginsImportResultV1Schema.parse(options.browserControl?.importPasskeys
            ? await options.browserControl.importPasskeys({ ...request.data, signal: context?.signal,
                principalAccountId: context?.machineAdmission?.actorAccountId })
            : await importNativePasskeys(request.data, context?.signal, context?.machineAdmission?.actorAccountId));
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES, async () =>
        BrowserLoginSourcesResultV1Schema.parse(await listBrowserCookieSources()));
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ, async (raw: unknown, context?: RpcHandlerContext) => {
        const request = BrowserCookieSourceReadV1Schema.safeParse(raw);
        if (!request.success) return { status: 'unavailable', code: 'source_format_unsupported' };
        return BrowserCookieSourceResultV1Schema.parse(await readBrowserCookieSource({ ...request.data.source,
            sites: request.data.sites, signal: context?.signal }));
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY, async (raw: unknown, context?: RpcHandlerContext) => {
        const request = BrowserCookieApplyV1Schema.safeParse(raw);
        if (!request.success) return { status: 'unavailable', code: 'import_failed' };
        // The admitted actor travels to the owner App continuation, which refuses another Account.
        return BrowserProfileLoginsImportResultV1Schema.parse(await importCookies(request.data, context?.signal,
            context?.machineAdmission?.actorAccountId));
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST, async (raw: unknown, context?: RpcHandlerContext) => {
        const request = DaemonBrowserViewListRequestV1Schema.parse(raw);
        if (!options.browserControl) return unavailableBrowserControl();
        return DaemonBrowserViewListResponseV1Schema.parse({ protocolVersion: 1,
            ...(context?.authorization?.kind === 'session.browser' ? { machineId: context.authorization.machineId } : {}),
            views: options.browserControl.listViews(request.browserSessionId, buildActionExecutorContextForRpc(context ?? {})) });
    });
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
        async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonBrowserControlDispatchResponseV1> => {
            const request = DaemonBrowserControlDispatchRequestV1Schema.parse(raw);
            if (!options.browserControl) {
                return unavailableBrowserControl();
            }
            const command = request.command;
            // This raw route is the human Browser surface. Agents take or hand back control only
            // through the browser.control Actions, whose approval policy owns Ask/Allow.
            const result = (command.kind === 'takeControl' || command.kind === 'handBack')
                && context?.callerAuthority !== 'present_user'
                ? browserCommandDispatchFailure({ commandId: command.commandId, code: 'permission_denied',
                    message: 'Browser controller commands from this route require the present user.' })
                : await options.browserControl.dispatchCommand(command, buildActionExecutorContextForRpc(context ?? {}));
            return DaemonBrowserControlDispatchResponseV1Schema.parse({
                protocolVersion: 1,
                result,
            });
        },
    );
}
