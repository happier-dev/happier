import type { Socket } from 'node:net';
import { prepareSessionMcpLocalTransport, type SessionMcpLocalTransportOptions } from './runtime/sessionMcpLocalTransport';
import { createServer, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { json } from 'node:stream/consumers';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { logger } from "@/ui/logger";
import { createHappierMcpServer } from "@/mcp/createHappierMcpServer";
import { listHappierMcpToolNames } from "@/mcp/resources/registerHappierMcpResources";
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
import { z } from 'zod/mini';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { SessionClientServerBinding } from '@/api/session/client/transport/sessionClientTransport';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { DaemonPluginToolCatalogUnavailableError } from './pluginToolCatalogError';
import { createSessionMcpToolInventory } from './server/sessionMcpToolInventory';
import { SessionCapabilityNoticeV1Schema, SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

const NativeAgentToolCallRequestV1Schema = z.strictObject({
    toolName: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    args: z.unknown(),
    toolCallId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
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
    getSessionRoleContext?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['getSessionRoleContext'];
    getCurrentSessionSkillItems?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['getCurrentSessionSkillItems'];
    getPluginMcpRuntimeRegistry?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['getPluginMcpRuntimeRegistry'];
    getPluginMcpPort?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['getPluginMcpPort'];
    getCurrentResolvedRoles?(): import('@happier-dev/protocol').ResolvedRolesSnapshotV1;
    readRoleSources?: import('@/session/roles/roleSources').RoleSourceReader;
    getCurrentWorkspaceWrites?(): 'allow' | 'deny' | undefined;
    prepareWorkspaceWritesPolicy?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['prepareWorkspaceWritesPolicy'];
    sessionId: string;
    getServerBinding(): SessionClientServerBinding;
    getMachineAdmissionTransport?: import('@/api/session/sessionClient').ApiSessionClient['getMachineAdmissionTransport'];
    mutateSessionMessageReply?: import('@/api/session/sessionClient').ApiSessionClient['mutateSessionMessageReply'];
    publishSessionMessageReply?: import('@/api/session/sessionClient').ApiSessionClient['publishSessionMessageReply'];
    getMcpRequestAuthPort?: import('@/api/session/sessionClient').ApiSessionClient['getMcpRequestAuthPort'];
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
    /** Existing host prompt/turn cancellation scope; capture before asynchronous tool admission. */
    getHostTurnAbortSignal?(): AbortSignal | null | undefined;
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
     * material, so this is what opens its own Board.
     */
    getStoredContentEncryptionContext?: SessionClientPort['getStoredContentEncryptionContext'];
};

type HappySessionToolRuntimeOptions = Readonly<{
    localTransport?: SessionMcpLocalTransportOptions;
    mcpToolCallIdMetaKey?: string;
    sessionCredentials?: StoredCredentials | null;
    credentials?: StoredCredentials | null;
    isCredentialCurrent?: () => boolean | Promise<boolean>;
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
    signal?: AbortSignal,
): Promise<readonly ProjectedPluginToolCatalogEntry[]> {
    return filterPluginToolsForActiveAgentComposition(
        await inventory.readPluginToolCatalog(signal),
        client.getActiveAgentCompositionToolSelection?.() ?? null,
    );
}

function readMcpToolExecutionSignal(client: HappyMcpSessionClient, requestSignal?: AbortSignal): AbortSignal | undefined {
    const signals = [requestSignal, client.getHostTurnAbortSignal?.(), client.getRuntimeLifetimeSignal?.()]
        .filter((signal): signal is AbortSignal => Boolean(signal));
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

export function registerHappierSessionAgentToolRpc(
    client: HappyMcpSessionClient,
    opts?: HappySessionToolRuntimeOptions,
): void {
    const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
        accountSettings: opts?.accountSettings ?? null,
        getAccountSettings: opts?.getAccountSettings ?? null,
        credentials: opts?.credentials,
        sessionCredentials: opts?.sessionCredentials,
        authorityScope: opts?.authorityScope,
    });
    const readToolInventory = createSessionMcpToolInventory({
        client, actionSettingsProvider,
        hasAuthenticatedRuntime: (opts?.sessionCredentials ?? opts?.credentials ?? null) !== null,
        authorityScope: opts?.authorityScope, requiredDirectActionIds: opts?.requiredDirectActionIds,
        pluginRuntimeRegistryLease: opts?.pluginRuntimeRegistryLease,
    });
    client.rpcHandlerManager.registerHandler(
        SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
        async (raw, requestContext) => {
            const toolExecutionSignal = readMcpToolExecutionSignal(client, requestContext?.signal);
            if (toolExecutionSignal?.aborted) return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
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
                pluginToolCatalog = await readCurrentPluginToolCatalog(client, readToolInventory, toolExecutionSignal);
            } catch (error) {
                if (toolExecutionSignal?.aborted) return { ok: false as const, errorCode: 'cancelled', error: 'cancelled' };
                if (!(error instanceof DaemonPluginToolCatalogUnavailableError)) throw error;
                return { ok: false as const, errorCode: error.code, error: error.message };
            }
            const runtime = createHappierMcpServer(client, {
                mcpToolCallIdMetaKey: opts?.mcpToolCallIdMetaKey,
                sessionCredentials: opts?.sessionCredentials ?? opts?.credentials ?? null,
                credentials: opts?.credentials ?? null,
                isCredentialCurrent: opts?.isCredentialCurrent,
                authorityScope: opts?.authorityScope ?? 'account',
                ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),
                actionsSettingsProvider: actionSettingsProvider,
                accountSettings: opts?.accountSettings ?? null,
                getAccountSettings: opts?.getAccountSettings ?? null,
                pluginToolCatalog,
                ...(toolExecutionSignal ? { toolExecutionSignal } : {}),
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
    // The bridge survives native runtime replacement. Discovery cannot inherit
    // the retiring incarnation's signal while its successor is still opening.
    const bridgeLifetime = new AbortController();
    // Invocation-only bridges already have a containing Run at construction;
    // ordinary Session bridges are prepared before the first native open.
    const ownerSignal = client.getRuntimeLifetimeSignal?.();
    const bridgeSignal = ownerSignal ? AbortSignal.any([bridgeLifetime.signal, ownerSignal]) : bridgeLifetime.signal;
    const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
        accountSettings: opts?.accountSettings ?? null,
        getAccountSettings: opts?.getAccountSettings ?? null,
        credentials: opts?.credentials,
        sessionCredentials: opts?.sessionCredentials,
        authorityScope: opts?.authorityScope,
    });
    const readToolInventory = createSessionMcpToolInventory({
        client, actionSettingsProvider,
        hasAuthenticatedRuntime: (opts?.sessionCredentials ?? opts?.credentials ?? null) !== null,
        authorityScope: opts?.authorityScope,
        requiredDirectActionIds: opts?.requiredDirectActionIds,
        pluginRuntimeRegistryLease: opts?.pluginRuntimeRegistryLease,
        lifetimeSignal: bridgeSignal,
    });
    const startupSignal = bridgeSignal;
    let initialPluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[];
    try {
        initialPluginToolCatalog = await readCurrentPluginToolCatalog(client, readToolInventory, startupSignal)
            .catch(async (error: unknown) => {
                startupSignal?.throwIfAborted();
                if (!(error instanceof DaemonPluginToolCatalogUnavailableError) || !client.enqueueSessionEventCommitted) throw error;
                const notice = SessionCapabilityNoticeV1Schema.parse({ v: 1, items: [{
                    kind: 'mcp_server', name: 'MCP plugin tools', code: error.code,
                }] });
                await client.enqueueSessionEventCommitted({ type: 'message',
                    message: `MCP plugin tools couldn't start · ${error.message}`,
                    [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice });
                // This is only the startup projection. The inventory's catalog
                // remains unadmitted; every POST and native tool call still
                // reads its exact current authority through the same owner.
                return [];
            });
        startupSignal?.throwIfAborted();
    } catch (error) {
        bridgeLifetime.abort(error);
        readToolInventory.dispose();
        throw error;
    }
    const initialToolInventory = readToolInventory(initialPluginToolCatalog);
    const toolsSnapshot = initialToolInventory.tools;
    const toolNamesSnapshot = listHappierMcpToolNames(toolsSnapshot.map((tool) => tool.name));
    const supportedSessionReadActions = listAdmittedSessionRunReadActionIds(toolsSnapshot);
    const keepAliveIntervalMs = configuration.mcpSseKeepAliveIntervalMs;

    let localTransport: Awaited<ReturnType<typeof prepareSessionMcpLocalTransport>> | undefined;
    try {
        if (opts?.localTransport) localTransport = await prepareSessionMcpLocalTransport(opts.localTransport);
    } catch (error) {
        bridgeLifetime.abort();
        readToolInventory.dispose();
        throw error;
    }

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        if (localTransport && !localTransport.authenticate(req.headers.authorization)) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        let parsedBody: unknown;
        if (req.method === 'POST') {
            try {
                parsedBody = await json(req);
            } catch {
                res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
                    jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null,
                }));
                return;
            }
        }
        // Codex resumes and lists tools before admitting its next host turn.
        // Discovery belongs to the bridge; tools/call also inherits native/turn cancellation.
        // The MCP SDK still validates and dispatches the parsed JSON-RPC message.
        const messages: readonly unknown[] = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
        const isToolCall = messages.some(
            message => message !== null && typeof message === 'object' && 'method' in message && message.method === 'tools/call',
        );
        const toolExecutionSignal = isToolCall
            ? readMcpToolExecutionSignal(client, bridgeSignal)
            : bridgeSignal;
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
                : await readCurrentPluginToolCatalog(client, readToolInventory, toolExecutionSignal);
        } catch (error) {
            stopKeepAlive();
            const cancelled = toolExecutionSignal?.aborted === true;
            logger.debug('[happierMCP] Plugin catalog unavailable', { error: cancelled ? 'cancelled' : 'daemon_plugin_catalog_unavailable' });
            if (!res.headersSent && !res.destroyed) {
                const failure = new DaemonPluginToolCatalogUnavailableError();
                res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({
                    ok: false, errorCode: cancelled ? 'cancelled' : failure.code, error: cancelled ? 'cancelled' : failure.message,
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
            mcpToolCallIdMetaKey: opts?.mcpToolCallIdMetaKey,
            sessionCredentials: opts?.sessionCredentials ?? opts?.credentials ?? null,
            credentials: opts?.credentials ?? null,
            isCredentialCurrent: opts?.isCredentialCurrent,
            authorityScope: opts?.authorityScope ?? 'account',
            ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),
            actionsSettingsProvider: actionSettingsProvider,
            accountSettings: opts?.accountSettings ?? null,
            getAccountSettings: opts?.getAccountSettings ?? null,
            pluginToolCatalog,
            ...(toolExecutionSignal ? { toolExecutionSignal } : {}),
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
            await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
            logger.debug('[happierMCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
        }
    });

    const connections = new Set<Socket>();
    server.on('connection', socket => {
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
    });
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        stopPromise = Promise.resolve().then(async () => {
            bridgeSignal.removeEventListener('abort', onOwnerAbort);
            bridgeLifetime.abort();
            readToolInventory.dispose();
            for (const socket of connections) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await localTransport?.retire();
        }).catch(error => {
            // Revoked authority stays revoked; a failed physical removal still
            // belongs to this same owner for the next explicit cleanup attempt.
            stopPromise = undefined;
            throw error;
        });
        return stopPromise;
    };
    const onOwnerAbort = () => { void stop(); };
    let baseUrl: URL;
    try {
        if (localTransport) {
            await localTransport.listen(server);
            // The SDK requires an HTTP URL; the dispatcher always uses the Unix socket.
            baseUrl = new URL('http://localhost/mcp');
        } else {
            // Existing non-isolated Windows transport; isolated launches never enter here.
            baseUrl = await new Promise<URL>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    server.off('error', reject);
                    const addr = server.address() as AddressInfo;
                    resolve(new URL(`http://127.0.0.1:${addr.port}`));
                });
            });
        }
        bridgeSignal.addEventListener('abort', onOwnerAbort, { once: true });
        bridgeSignal.throwIfAborted();
    } catch (error) {
        await stop();
        throw error;
    }

    return {
        url: baseUrl.toString(),
        get localContext() { return localTransport?.localContext; },
        ...(localTransport?.contextFilePath ? { contextFilePath: localTransport.contextFilePath } : {}),
        toolNames: toolNamesSnapshot,
        readToolNames: async (signal?: AbortSignal) => {
            const operationSignal = signal ? AbortSignal.any([bridgeSignal, signal]) : bridgeSignal;
            operationSignal?.throwIfAborted();
            const catalog = await readCurrentPluginToolCatalog(client, readToolInventory, operationSignal);
            operationSignal?.throwIfAborted();
            return listHappierMcpToolNames(readToolInventory(catalog).tools.map(tool => tool.name));
        },
        supportedSessionReadActions,
        stop,
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
