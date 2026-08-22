import { createServer, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { logger } from "@/ui/logger";
import { createHappierMcpServer } from "@/mcp/createHappierMcpServer";
import { listBuiltInHappierTools } from "@/agent/tools/happierTools/listBuiltInHappierTools";
import type { RpcHandlerManagerLike } from "@/api/rpc/types";
import type { Metadata } from "@/api/types";
import type { PermissionMode } from "@/api/types";
import { configuration } from "@/configuration";
import type { StoredCredentials } from '@/persistence';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { ExecutionRunServiceResult, WaitForExecutionRunResult } from "@/session/services/executionRuns";
import type {
    AccountSettings,
    BackendTargetRefV2,
    SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import {
    createMcpActionEnablement,
    createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';

export type HappyMcpExecutionRunService = Readonly<{
    start: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    list: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    get: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    send: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    stop: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    action: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    wait?: (request: unknown) => Promise<ExecutionRunServiceResult<unknown> | WaitForExecutionRunResult>;
}>;

export type HappyMcpSessionClient = {
    sessionId: string;
    rpcHandlerManager: RpcHandlerManagerLike;
    updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
    getMetadataSnapshot?(): Metadata | null;
    getPermissionMode?(): PermissionMode | null | undefined;
    getActiveTurnCausalPermissionAuthority?(): SessionInputCausalPermissionAuthorityV1 | null | undefined;
    getBackendTarget?(): BackendTargetRefV2 | null | undefined;
    getCurrentSessionLocation?(): Readonly<{
        path?: string | null;
        host?: string | null;
        machineId?: string | null;
    }> | null | undefined;
    getActiveAgentCompositionToolSelection?(): AgentCompositionToolSelection | null | undefined;
    executionRuns?: HappyMcpExecutionRunService;
};

export function filterPluginToolsForActiveAgentComposition(
    pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[],
    selection: AgentCompositionToolSelection | null | undefined,
): readonly ProjectedPluginToolCatalogEntry[] {
    if (!selection || selection.managedPluginIds.length === 0) {
        return pluginToolCatalog;
    }
    const managedPluginIds = new Set(selection.managedPluginIds);
    const selectedToolIds = new Set(selection.selectedTools.map(
        (tool) => `${tool.pluginId}/${tool.localId}`,
    ));
    const currentUnmanagedTools = pluginToolCatalog.filter((tool) => {
        const separatorIndex = tool.toolId.indexOf('/');
        const pluginId = separatorIndex > 0 ? tool.toolId.slice(0, separatorIndex) : null;
        return pluginId === null || !managedPluginIds.has(pluginId);
    });
    const selectedTurnTools = selection.selectedToolBindings.flatMap((binding) => {
        const separatorIndex = binding.tool.toolId.indexOf('/');
        const pluginId = separatorIndex > 0 ? binding.tool.toolId.slice(0, separatorIndex) : null;
        const immutableGenerationId = binding.expectedContributorImmutableGenerationId.trim();
        if (
            pluginId === null
            || !managedPluginIds.has(pluginId)
            || !selectedToolIds.has(binding.tool.toolId)
            || immutableGenerationId.length === 0
        ) {
            return [];
        }
        return [Object.freeze({
            ...binding.tool,
            expectedContributorImmutableGenerationId: immutableGenerationId,
        })];
    });
    // The daemon catalog remains the sole current catalog for unmanaged tools.
    // Managed selections use only the immutable snapshot admitted for this
    // turn; a missing/invalid binding fails closed instead of rereading a
    // replacement plugin after a reload.
    return Object.freeze([
        ...currentUnmanagedTools,
        ...selectedTurnTools,
    ].sort((left, right) => left.name.localeCompare(right.name) || left.toolId.localeCompare(right.toolId)));
}

export async function startHappyServer(
    client: HappyMcpSessionClient,
    opts?: Readonly<{
        credentials?: StoredCredentials | null;
        accountSettings?: AccountSettings | null;
        getAccountSettings?: (() => AccountSettings | null) | null;
    }>,
) {
    // Do not eagerly construct an MCP server on startup; only snapshot the names.
    // Full server creation is done per request inside the handler.
    const actionSettingsProvider = createMcpActionSettingsProvider({
        accountSettings: opts?.accountSettings ?? null,
        getAccountSettings: opts?.getAccountSettings ?? null,
    });
  const isActionEnabled = createMcpActionEnablement({
        actionSettingsProvider,
        surface: 'agent',
  });
  const readCurrentPluginToolCatalog = async () => {
    const daemonCatalog = await readDaemonPluginCatalog().catch(() => ({
      kind: 'unavailable' as const,
      code: 'daemon_unavailable',
    }));
    return daemonCatalog.kind === 'available'
      ? filterPluginToolsForActiveAgentComposition(
        daemonCatalog.tools,
        client.getActiveAgentCompositionToolSelection?.() ?? null,
      )
      : Object.freeze([]);
  };
  const initialPluginToolCatalog = await readCurrentPluginToolCatalog();
  const toolNamesSnapshot = listBuiltInHappierTools({
    surface: 'agent',
    isActionEnabled,
    actionsSettings: actionSettingsProvider.getActionsSettings(),
    pluginToolCatalog: initialPluginToolCatalog,
  }).map((tool) => tool.name);
  const keepAliveIntervalMs = configuration.mcpSseKeepAliveIntervalMs;

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        // Claude Code keeps a long-lived standalone GET SSE stream open for MCP notifications.
        // Without periodic bytes on that stream, the client times out and reconnects every ~5 minutes.
        // Keepalives are only needed for the standalone GET stream (POST response streams are short-lived).
        const stopKeepAlive = req.method === 'GET' ? startMcpSseKeepAlive(res, keepAliveIntervalMs) : () => {};

        // Build a fresh MCP server + transport per request.
        //
        // We intentionally run in stateless mode (no session IDs) because some
        // clients re-send initialize and do not keep MCP session headers.
        // In newer MCP SDK versions, stateless transports are single-use; reusing
        // one transport across requests can surface as client-side "Error POSTing to endpoint".
        const { mcp } = createHappierMcpServer(client, {
            credentials: opts?.credentials ?? null,
            accountSettings: opts?.accountSettings ?? null,
            getAccountSettings: opts?.getAccountSettings ?? null,
            pluginToolCatalog: await readCurrentPluginToolCatalog(),
        });

        const transport = new StreamableHTTPServerTransport({
            // NOTE: Returning session id here will result in claude
            // sdk spawn to fail with `Invalid Request: Server already initialized`
            sessionIdGenerator: undefined,
        });

        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;

            stopKeepAlive();

            try {
                await transport.close();
            } catch (error) {
                logger.debug('[happierMCP] Error closing transport:', error);
            }

            try {
                await Promise.resolve(mcp.close());
            } catch (error) {
                logger.debug('[happierMCP] Error closing server:', error);
            }
        };

        res.once('close', () => {
            cleanup().catch((error) => {
                logger.debug('[happierMCP] Error during request cleanup:', error);
            });
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug('[happierMCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: toolNamesSnapshot,
        stop: () => {
            logger.debug('[happierMCP] Stopping server');
            server.close();
        }
    }
}

function startMcpSseKeepAlive(res: ServerResponse, keepAliveIntervalMs: number | null): () => void {
    if (!keepAliveIntervalMs) {
        return () => {};
    }

    let stopped = false;
    let keepAliveTimer: NodeJS.Timeout | null = null;

    const originalSetHeader = res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        // Restore patched methods (defense-in-depth; these response objects are per-request).
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res as any).setHeader = originalSetHeader;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res as any).writeHead = originalWriteHead;
        } catch {
            // best-effort
        }
    };

    let started = false;

    const tryWriteKeepAlive = () => {
        if (stopped) return;
        if (res.writableEnded || res.destroyed) {
            stop();
            return;
        }
        try {
            // SSE comment (":") is ignored by clients and safe to interleave with message events.
            res.write(':\n\n');
        } catch {
            stop();
        }
    };

    const startKeepAlive = () => {
        if (started) return;
        started = true;
        // Defer the first write to avoid racing the underlying transport's SSE setup.
        const immediate = setTimeout(tryWriteKeepAlive, 0);
        immediate.unref?.();
        keepAliveTimer = setInterval(tryWriteKeepAlive, keepAliveIntervalMs);
        keepAliveTimer.unref?.();
    };

    const maybeStartFromHeader = (name: unknown, value: unknown) => {
        if (stopped || started) return;
        const headerName = typeof name === 'string' ? name.toLowerCase() : '';
        if (headerName && headerName !== 'content-type') return;
        const serialized = Array.isArray(value) ? value.map((v) => String(v)).join(',') : String(value ?? '');
        if (!serialized.includes('text/event-stream')) return;
        startKeepAlive();
    };

    // Start keepalives as soon as the underlying transport configures an SSE response.
    // This prevents clients with idle timeouts from dropping the stream during long periods of inactivity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).setHeader = (name: string, value: unknown) => {
        originalSetHeader(name, value as any);
        maybeStartFromHeader(name, value);
        return res;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).writeHead = (...args: unknown[]) => {
        const result = (originalWriteHead as unknown as (...inner: any[]) => unknown)(...(args as any[]));

        let headersArg: Record<string, unknown> | null = null;
        for (let i = args.length - 1; i >= 0; i--) {
            const value = args[i];
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            headersArg = value as Record<string, unknown>;
            break;
        }

        if (headersArg) {
            for (const [k, v] of Object.entries(headersArg)) {
                maybeStartFromHeader(k, v);
            }
        }

        if (!started) {
            maybeStartFromHeader('content-type', res.getHeader('content-type'));
        }

        return result;
    };

    res.once('close', stop);
    res.once('finish', stop);

    return stop;
}
