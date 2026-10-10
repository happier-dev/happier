import { createServer, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { logger } from "@/ui/logger";
import { createHappierMcpServer } from "@/mcp/createHappierMcpServer";
import {
    listAdmittedSessionRunReadActionIds,
} from "@/agent/tools/happierTools/listBuiltInHappierTools";
import type { RpcHandlerManagerLike } from "@/api/rpc/types";
import type { Metadata } from "@/api/types";
import type { PermissionMode } from "@/api/types";
import { configuration } from "@/configuration";
import type { StoredCredentials } from '@/persistence';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import {
    type ProjectedPluginToolCatalogEntry,
} from '@/plugins/runtime/toolCatalog';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ExecutionRunServiceResult, WaitForExecutionRunResult } from "@/session/services/executionRuns";
import type {
    ActionId,
    AccountSettings,
    ActionExecutorDeps,
    BackendTargetRefV2,
} from '@happier-dev/protocol';
import type { RuntimeActiveTurnPermissionWitness } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SessionClientServerBinding } from '@/api/session/client/transport/sessionClientTransport';
import { DaemonPluginToolCatalogUnavailableError } from './pluginToolCatalogError';
import { createSessionMcpToolInventory } from './server/sessionMcpToolInventory';

const NativeAgentToolCallRequestV1Schema = z.strictObject({
    toolName: z.string().trim().min(1).max(256),
    args: z.unknown(),
    toolCallId: z.string().trim().min(1).max(512).optional(),
});

export type HappyMcpExecutionRunService = Readonly<{
    start: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    list: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    get: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    send: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    stop: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    action: (request: unknown) => Promise<ExecutionRunServiceResult<unknown>>;
    wait?: (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<ExecutionRunServiceResult<unknown> | WaitForExecutionRunResult>;
}>;

export type HappyMcpSessionClient = {
    getCurrentResolvedRoles?(): import('@happier-dev/protocol').ResolvedRolesSnapshotV1;
    readRoleSources?: import('@/session/roles/roleSources').RoleSourceReader;
    getCurrentWorkspaceWrites?(): 'allow' | 'deny' | undefined;
    prepareWorkspaceWritesPolicy?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['prepareWorkspaceWritesPolicy'];
    sessionId: string;
    getServerBinding(): SessionClientServerBinding;
    getMachineAdmissionTransport?: import('@/api/session/sessionClient').ApiSessionClient['getMachineAdmissionTransport'];
    rpcHandlerManager: RpcHandlerManagerLike;
    updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
    enqueueRegisteredSessionStateFieldMutation?: import('@/api/session/sessionClient').ApiSessionClient['enqueueRegisteredSessionStateFieldMutation'];
    enqueueSessionEventCommitted?: import('@/api/session/sessionClient').ApiSessionClient['enqueueSessionEventCommitted'];
    getMetadataSnapshot?(): Metadata | null;
    getPermissionMode?(): PermissionMode | null | undefined;
    /** Host-owned absolute starter depth, never a tool request field. */
    getWorkDepth?(): number;
    /** Depth stamped by the host for this exact admitted turn. */
    getHostTurnWorkDepth?(turnId: string): number | undefined;
    /** Host-stamped Run caller, independent of confirmation/active-turn UI state. */
    getAgentStartRunCaller?(): import('@/session/actions/resolveCliAgentStartContextV1').AgentStartRunCallerBinding | null;
    getActiveTurnPermissionWitness?(): RuntimeActiveTurnPermissionWitness | null | undefined;
    /** Full host admission identity for the existing authenticated daemon channel. */
    getActiveTurnAdmissionWitness?(): import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness | null;
    getRuntimeLifetimeSignal?(): AbortSignal | null | undefined;
    getEphemeralStreamConnectionEpoch?: import('@/api/session/sessionClient').ApiSessionClient['getEphemeralStreamConnectionEpoch'];
    subscribeDaemonPluginCatalogChanges?: import('@/api/session/sessionClient').ApiSessionClient['subscribeDaemonPluginCatalogChanges'];
    isDaemonPluginCatalogSignalReady?: import('@/api/session/sessionClient').ApiSessionClient['isDaemonPluginCatalogSignalReady'];
    getServerFeaturesSnapshot?(): CliServerFeaturesSnapshot | undefined;
    getSessionActionConfirmationBinding?(): import('@/session/actions/approvals/sessionActionConfirmation').SessionActionConfirmationRuntimeBinding | null;
    confirmSessionAction?: import('@/api/session/sessionClient').ApiSessionClient['confirmSessionAction'];
    postAgentDiscussionMessage?: import('@/api/session/sessionClient').ApiSessionClient['postAgentDiscussionMessage'];
    getBackendTarget?(): BackendTargetRefV2 | null | undefined;
    getCurrentSessionLocation?(): Readonly<{
        path?: string | null;
        host?: string | null;
        machineId?: string | null;
    }> | null | undefined;
    getActiveAgentCompositionToolSelection?(): AgentCompositionToolSelection | null | undefined;
    executionRuns?: HappyMcpExecutionRunService;
    /**
     * Stored-content material the live Session client already holds for this
     * exact Session. A Session-scoped runtime (a Runner) has no Account
     * material, so this is what opens its own Board and Discussions.
     */
    getStoredContentEncryptionContext?(): Readonly<{
        mode: 'plain' | 'e2ee';
        ctx?: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
    }>;
};

type HappySessionToolRuntimeOptions = Readonly<{
    sessionCredentials?: StoredCredentials | null;
    credentials?: StoredCredentials | null;
    authorityScope?: 'account' | 'session';
    sessionList?: ActionExecutorDeps['sessionList'];
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    accountSettings?: AccountSettings | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
    requiredDirectActionIds?: readonly ActionId[];
    /** Exact caller-owned registry lease for daemonless scoped runtimes. */
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
}>;

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
        const occurrenceId = binding.expectedContributorOccurrenceId.trim();
        if (
            pluginId === null
            || !managedPluginIds.has(pluginId)
            || !selectedToolIds.has(binding.tool.toolId)
            || occurrenceId.length === 0
        ) {
            return [];
        }
        return [Object.freeze({
            ...binding.tool,
            expectedContributorOccurrenceId: occurrenceId,
        })];
    });
    // The supplied catalog remains the sole current catalog for unmanaged tools.
    // Managed selections use only the process occurrence admitted for this
    // turn; a missing/invalid binding fails closed instead of rereading a
    // replacement plugin after a reload.
    return Object.freeze([
        ...currentUnmanagedTools,
        ...selectedTurnTools,
    ].sort((left, right) => left.name.localeCompare(right.name) || left.toolId.localeCompare(right.toolId)));
}

async function readCurrentPluginToolCatalog(
    client: HappyMcpSessionClient,
    inventory: ReturnType<typeof createSessionMcpToolInventory>,
): Promise<readonly ProjectedPluginToolCatalogEntry[]> {
    return filterPluginToolsForActiveAgentComposition(
        await inventory.readPluginToolCatalog(),
        client.getActiveAgentCompositionToolSelection?.() ?? null,
    );
}

export function registerHappierSessionAgentToolRpc(
    client: HappyMcpSessionClient,
    opts?: HappySessionToolRuntimeOptions,
): void {
    const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
        accountSettings: opts?.accountSettings ?? null,
        getAccountSettings: opts?.getAccountSettings ?? null,
        scopeKey: opts?.credentials
            ? resolveAccountSettingsScopeKeyForToken(opts.credentials.token)
            : null,
    });
    const readToolInventory = createSessionMcpToolInventory({
        client, actionSettingsProvider,
        hasAuthenticatedRuntime: (opts?.sessionCredentials ?? opts?.credentials ?? null) !== null,
        authorityScope: opts?.authorityScope, requiredDirectActionIds: opts?.requiredDirectActionIds,
        pluginRuntimeRegistryLease: opts?.pluginRuntimeRegistryLease,
    });
    client.rpcHandlerManager.registerHandler(
        SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
        async (raw) => {
            const parsed = NativeAgentToolCallRequestV1Schema.safeParse(raw);
            if (!parsed.success) {
                return {
                    ok: false as const,
                    errorCode: 'invalid_action_input',
                    error: 'invalid_action_input',
                };
            }
            let pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[];
            try {
                pluginToolCatalog = await readCurrentPluginToolCatalog(client, readToolInventory);
            } catch (error) {
                if (!(error instanceof DaemonPluginToolCatalogUnavailableError)) throw error;
                return { ok: false as const, errorCode: error.code, error: error.message };
            }
            const runtime = createHappierMcpServer(client, {
                sessionCredentials: opts?.sessionCredentials ?? opts?.credentials ?? null,
                credentials: opts?.credentials ?? null,
                authorityScope: opts?.authorityScope ?? 'account',
                ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),
                actionsSettingsProvider: actionSettingsProvider,
                accountSettings: opts?.accountSettings ?? null,
                getAccountSettings: opts?.getAccountSettings ?? null,
                pluginToolCatalog,
                toolInventory: readToolInventory(pluginToolCatalog),
                ...(opts?.pluginRuntimeRegistryLease
                    ? { pluginRuntimeRegistryLease: opts.pluginRuntimeRegistryLease }
                    : {}),
                requiredDirectActionIds: opts?.requiredDirectActionIds,
                sessionInputVia: 'action',
            });
            try {
                return await runtime.executeTool({
                    toolName: parsed.data.toolName,
                    args: parsed.data.args,
                    ...(parsed.data.toolCallId ? { toolCallId: parsed.data.toolCallId } : {}),
                });
            } finally {
                await Promise.resolve(runtime.mcp.close()).catch(() => {});
            }
        },
    );
}

export async function startHappyServer(
    client: HappyMcpSessionClient,
    opts?: HappySessionToolRuntimeOptions,
) {
    // Transports remain request-local; reuse the bridge's admitted inventory.
    const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
        accountSettings: opts?.accountSettings ?? null,
        getAccountSettings: opts?.getAccountSettings ?? null,
        scopeKey: opts?.credentials
            ? resolveAccountSettingsScopeKeyForToken(opts.credentials.token)
            : null,
    });
    const readToolInventory = createSessionMcpToolInventory({
        client, actionSettingsProvider,
        hasAuthenticatedRuntime: (opts?.sessionCredentials ?? opts?.credentials ?? null) !== null,
        authorityScope: opts?.authorityScope,
        requiredDirectActionIds: opts?.requiredDirectActionIds,
        pluginRuntimeRegistryLease: opts?.pluginRuntimeRegistryLease,
    });
    const initialPluginToolCatalog = await readCurrentPluginToolCatalog(client, readToolInventory)
        .catch(error => { readToolInventory.dispose(); throw error; });
    const initialToolInventory = readToolInventory(initialPluginToolCatalog);
    const toolsSnapshot = initialToolInventory.tools;
    const toolNamesSnapshot = toolsSnapshot.map((tool) => tool.name);
    const supportedSessionReadActions = listAdmittedSessionRunReadActionIds(toolsSnapshot);
    const keepAliveIntervalMs = configuration.mcpSseKeepAliveIntervalMs;

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        // Claude Code keeps a long-lived standalone GET SSE stream open for MCP notifications.
        // Without periodic bytes on that stream, the client times out and reconnects every ~5 minutes.
        // Keepalives are only needed for the standalone GET stream (POST response streams are short-lived).
        const stopKeepAlive = req.method === 'GET' ? startMcpSseKeepAlive(res, keepAliveIntervalMs) : () => {};

        let pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[];
        try {
            // GET only opens the notification stream; the SDK cannot dispatch
            // tools from it. Keep its already-admitted startup registrations
            // without making notification transport depend on a fresh catalog.
            // POST requests still bind the current executable catalog.
            pluginToolCatalog = req.method === 'GET'
                ? initialPluginToolCatalog
                : await readCurrentPluginToolCatalog(client, readToolInventory);
        } catch (error) {
            stopKeepAlive();
            logger.debug('[happierMCP] Plugin catalog unavailable', { error: 'daemon_plugin_catalog_unavailable' });
            if (!res.headersSent && !res.destroyed) {
                const failure = new DaemonPluginToolCatalogUnavailableError();
                res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({
                    ok: false, errorCode: failure.code, error: failure.message,
                }));
            } else if (!res.destroyed) {
                res.end();
            }
            return;
        }

        // Build a fresh MCP server + transport per request.
        //
        // We intentionally run in stateless mode (no session IDs) because some
        // clients re-send initialize and do not keep MCP session headers.
        // In newer MCP SDK versions, stateless transports are single-use; reusing
        // one transport across requests can surface as client-side "Error POSTing to endpoint".
        const { mcp } = createHappierMcpServer(client, {
            sessionCredentials: opts?.sessionCredentials ?? opts?.credentials ?? null,
            credentials: opts?.credentials ?? null,
            authorityScope: opts?.authorityScope ?? 'account',
            ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),
            actionsSettingsProvider: actionSettingsProvider,
            accountSettings: opts?.accountSettings ?? null,
            getAccountSettings: opts?.getAccountSettings ?? null,
            pluginToolCatalog,
            toolInventory: req.method === 'GET' ? initialToolInventory : readToolInventory(pluginToolCatalog),
            ...(opts?.pluginRuntimeRegistryLease
                ? { pluginRuntimeRegistryLease: opts.pluginRuntimeRegistryLease }
                : {}),
            requiredDirectActionIds: opts?.requiredDirectActionIds,
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
        supportedSessionReadActions,
        stop: () => {
            logger.debug('[happierMCP] Stopping server');
            readToolInventory.dispose();
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
