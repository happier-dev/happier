import { randomUUID } from 'node:crypto';
import { readSessionMcpToolCallId, SESSION_MCP_ACTION_REQUEST_ID_META_KEY } from '../runtime/sessionMcpToolsBridge';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createHappierToolInventory, type HappierToolInventory, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import type { ActionId, ActionsSettingsV1, ApprovalRequestOriginV1, BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BrowserScreenshotMediaReferenceV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { SessionImageMediaReferenceV1Schema } from '@happier-dev/protocol/sessions/media/imageReferenceV1';
import type { HappierBuiltInToolDefinition, HappierBuiltInToolDispatchResult } from '@/agent/tools/happierTools/types';
import { projectActionExecuteFailure, projectActionFailureForAgentV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { z } from 'zod/mini';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { toMcpToolInputSchema } from './toolSchemas';
import {
    BrowserMediaUnavailableError,
    browserMediaToStructuredImageInput,
    SessionMediaUnavailableError,
    sessionMediaToStructuredImageInput,
    verifySessionStructuredImageInput,
} from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';

const MCP_TOOL_PROGRESS_KEEPALIVE_INTERVAL_MS = 15_000;

type McpToolRegistrationMetadata = Pick<RegisteredTool, 'title' | 'description' | 'annotations' | '_meta'> & Readonly<{
    inputSchema: z.ZodMiniType;
    outputSchema?: z.ZodMiniType;
}>;

export type ToolRegistrar<TExtra = unknown> = Readonly<{
    registerTool: (name: string, meta: McpToolRegistrationMetadata, handler: (args: unknown, extra?: TExtra) => Promise<CallToolResult>) => void;
}>;

export type HappierMcpToolInventory = HappierToolInventory & Readonly<{
    registrations: readonly Readonly<{
        tool: HappierBuiltInToolDefinition;
        actionId: string | null;
        meta: McpToolRegistrationMetadata;
    }>[];
}>;

type DispatchDeps = Parameters<typeof dispatchBuiltInHappierTool>[0]['deps'];

type McpRequestHandlerExtra = Readonly<{
    _meta?: Readonly<{ progressToken?: unknown }>;
    signal?: AbortSignal;
    sendNotification?: (notification: Readonly<{
        method: 'notifications/progress';
        params: Readonly<{ progressToken: string | number; progress: number }>;
    }>) => Promise<void>;
}>;

function startMcpToolProgressKeepalive(extra: unknown): () => void {
    const request = extra && typeof extra === 'object' ? extra as McpRequestHandlerExtra : null;
    const progressToken = request?._meta?.progressToken;
    const sendNotification = request?.sendNotification;
    const signal = request?.signal;
    if (
        (typeof progressToken !== 'string' && typeof progressToken !== 'number')
        || typeof sendNotification !== 'function'
        || signal?.aborted === true
    ) {
        return () => undefined;
    }

    let progress = 0;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        signal?.removeEventListener('abort', stop);
    };
    timer = setInterval(() => {
        progress += 1;
        void sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress },
        }).catch((error) => {
            stop();
            logger.debug('[happierMCP] Failed to send tool progress keepalive', error);
        });
    }, MCP_TOOL_PROGRESS_KEEPALIVE_INTERVAL_MS);
    timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
    return stop;
}

function buildSessionAgentApprovalOrigin(params: Readonly<{
    surface: BuiltInHappierToolsSurface;
    sessionId?: string;
    toolName: string;
    extra: unknown;
    toolCallId?: string;
}>): ApprovalRequestOriginV1 | null {
    if (params.surface !== 'agent' || !params.sessionId) return null;
    const rawRequestId = (params.extra as { requestId?: unknown } | null | undefined)?.requestId;
    const requestId =
        typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
            ? String(rawRequestId).trim()
            : '';
    return {
        kind: 'transcript_tool_call',
        sessionId: params.sessionId,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(requestId ? { mcpRequestId: requestId } : {}),
        toolName: params.toolName,
    };
}

function buildPluginToolMcpMeta(tool: HappierBuiltInToolDefinition): Record<string, unknown> | undefined {
    if (!tool.toolId || !tool.actionId || !tool.safety) return undefined;
    return {
        'happier.dev/pluginTool': {
            toolId: tool.toolId,
            actionId: tool.actionId,
            safety: tool.safety,
            ...(tool.inputHints === undefined ? {} : { inputHints: tool.inputHints }),
            ...(tool.examples === undefined ? {} : { examples: tool.examples }),
            ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
            ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
            ...(tool.availability === undefined ? {} : { availability: tool.availability }),
        },
    };
}

function resolveMcpToolAnnotations(tool: HappierBuiltInToolDefinition): ToolAnnotations | undefined {
    if (tool.annotations !== undefined) {
        return tool.annotations;
    }
    return tool.safety === undefined
        ? undefined
        : { destructiveHint: tool.safety === 'danger' };
}

function stringifyMcpToolTextPayload(value: unknown): string {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : 'null';
}

export function formatHappierMcpToolFailure(result: Extract<HappierBuiltInToolDispatchResult, { ok: false }>): CallToolResult {
    const { ok: _ok, ...failure } = projectActionFailureForAgentV1(projectActionExecuteFailure(result));
    return {
        content: [{ type: 'text', text: JSON.stringify({
            ...failure,
            ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
        }) }],
        isError: true,
    };
}

function readBrowserResultMedia(value: unknown): readonly BrowserScreenshotMediaReferenceV1[] {
    const references = new Map<string, BrowserScreenshotMediaReferenceV1>();
    const visit = (entry: unknown): void => {
        if (!entry || typeof entry !== 'object') return;
        if (Array.isArray(entry)) { entry.forEach(visit); return; }
        const record = entry as Record<string, unknown>;
        if (record.mediaKind === 'image' && typeof record.mediaId === 'string') {
            const parsed = BrowserScreenshotMediaReferenceV1Schema.safeParse(record);
            if (!parsed.success) throw new BrowserMediaUnavailableError();
            const existing = references.get(parsed.data.mediaId);
            if (existing && JSON.stringify(existing) !== JSON.stringify(parsed.data)) throw new BrowserMediaUnavailableError();
            references.set(parsed.data.mediaId, parsed.data);
            return;
        }
        Object.values(record).forEach(visit);
    };
    visit(value);
    return [...references.values()];
}

/** Bind presentation schemas once for the exact Session and admitted inventory. */
export function prepareHappierMcpToolInventory(params: Readonly<{
    inventory: HappierToolInventory;
    sessionId?: string;
    sessionMachineId?: string | null;
    sessionRootPath?: string | null;
}>): HappierMcpToolInventory {
    const registrations = params.inventory.tools.flatMap(tool => {
        try {
            const actionId = params.inventory.actionToolNameToId.get(tool.name) ?? null;
            const pluginToolMcpMeta = buildPluginToolMcpMeta(tool);
            const annotations = resolveMcpToolAnnotations(tool);
            const meta = {
                description: tool.description,
                title: tool.title,
                inputSchema: toMcpToolInputSchema({
                    actionId, inputSchema: tool.inputSchema, sessionId: params.sessionId,
                    sessionMachineId: params.sessionMachineId, sessionRootPath: params.sessionRootPath, contextualDefaults: tool.contextualDefaults,
                }),
                ...(annotations === undefined ? {} : { annotations }),
                ...(pluginToolMcpMeta === undefined ? {} : { _meta: pluginToolMcpMeta }),
            };
            return [{ tool, actionId, meta }];
        } catch (error) {
            // Match contribution projection policy: a malformed plugin entry
            // is unavailable, while healthy entries retain their real schemas.
            // Host Action/parser failures remain strict and identify their owner.
            if (!tool.toolId) {
                if (error instanceof Error) {
                    error.message = `MCP tool '${tool.name}' (${tool.actionId ?? 'manual'}): ${error.message}`;
                    throw error;
                }
                throw new Error(`MCP tool '${tool.name}' (${tool.actionId ?? 'manual'}) schema preparation failed`, { cause: error });
            }
            logger.warnLocalFile('[happierMCP] Plugin tool unavailable', {
                code: 'action_schema_invalid', toolId: tool.toolId,
                actionId: tool.actionId, name: tool.name,
                reason: error instanceof Error ? error.message : 'Schema preparation failed',
            });
            return [];
        }
    });
    return {
        ...params.inventory,
        tools: registrations.map(({ tool }) => tool),
        actionToolNameToId: new Map(registrations.flatMap(({ tool, actionId }) => actionId ? [[tool.name, actionId] as const] : [])),
        registrations,
    };
}

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId?: string;
        workingDirectory?: string | null;
        sessionMachineId?: string | null;
        mcpToolCallIdMetaKey?: string;
        surface: BuiltInHappierToolsSurface;
        happierToolsEnabled?: boolean;
        actionsSettings?: ActionsSettingsV1 | null;
        getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
        pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
        requiredDirectActionIds?: readonly ActionId[];
        toolInventory?: HappierMcpToolInventory;
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string | undefined;
    }>,
): Readonly<{ toolNames: string[] }> {
    // This registrar intentionally exposes first-party built-in Happier tools.
    // Plugin-contributed direct tools use the ActionSpec/tool projection path.
    const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
    const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
    const actionsSettings = readActionsSettings();
    const inventory = params.happierToolsEnabled !== false && params.toolInventory ? params.toolInventory : prepareHappierMcpToolInventory({
        sessionId: params.sessionId,
        sessionMachineId: params.sessionMachineId,
        sessionRootPath: params.workingDirectory,
        inventory: createHappierToolInventory({
            surface: params.surface,
            happierToolsEnabled: params.happierToolsEnabled,
            isActionEnabled,
            actionsSettings,
            pluginToolCatalog: params.pluginToolCatalog,
            requiredDirectActionIds: params.requiredDirectActionIds,
        }),
    });
    const { tools: enabledTools } = inventory;

    for (const { tool, actionId, meta } of inventory.registrations) {
        server.registerTool(
            tool.name,
            meta,
            async (args: unknown, extra?: unknown): Promise<CallToolResult> => {
                const stopProgressKeepalive = startMcpToolProgressKeepalive(extra);
                try {
                    const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                    const metadata = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
                    const nativeId = readSessionMcpToolCallId(metadata, params.mcpToolCallIdMetaKey);
                    const approvalOrigin = buildSessionAgentApprovalOrigin({
                        surface: params.surface,
                        sessionId,
                        toolName: tool.name,
                        extra,
                        toolCallId: typeof nativeId === 'string' ? nativeId.trim() || undefined : undefined,
                    });
                    // JSON-RPC ids correlate a connection and can restart at zero,
                    // including when a new client reaches this same live server.
                    // Keep them in approval provenance, never operation identity.
                    const requestedActionRequestId = metadata?.[SESSION_MCP_ACTION_REQUEST_ID_META_KEY];
                    const parsedActionRequestId = requestedActionRequestId === undefined
                        ? null : ExternalActionRequestIdV1Schema.safeParse(requestedActionRequestId);
                    if (parsedActionRequestId && !parsedActionRequestId.success) {
                        return formatHappierMcpToolFailure({ ok: false, errorCode: 'invalid_parameters',
                            error: 'Invalid Action request id.' });
                    }
                    const actionRequestId = parsedActionRequestId?.success ? parsedActionRequestId.data : randomUUID();
                    const currentActionsSettings = readActionsSettings();
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        sessionMachineId: params.sessionMachineId,
                        sessionRootPath: params.workingDirectory,
                        surface: params.surface,
                        actionsSettings: currentActionsSettings,
                        getActionsSettings: readActionsSettings,
                        pluginToolCatalog: params.pluginToolCatalog,
                        requiredDirectActionIds: params.requiredDirectActionIds,
                        ...(approvalOrigin ? { approvalOrigin } : {}),
                        actionRequestId,
                        ...((extra as McpRequestHandlerExtra | undefined)?.signal
                            ? { signal: (extra as McpRequestHandlerExtra).signal } : {}),
                        deps: params.deps,
                    });

                    if (result.ok) {
                        const requestedActionId = tool.name === 'action_execute' && args && typeof args === 'object'
                            ? (args as Record<string, unknown>).actionId : actionId;
                        const images: { type: 'image'; data: string; mimeType: string }[] = [];
                        // Browser Action dispatch owns consent/redaction. Only its authorized result
                        // is projected; arbitrary plugin or non-browser results are not file claims.
                        if (typeof requestedActionId === 'string' && requestedActionId.startsWith('browser.context.')) {
                            for (const media of readBrowserResultMedia(result.result)) {
                                if (!sessionId) throw new SessionMediaUnavailableError();
                                const verified = await verifySessionStructuredImageInput({
                                    cwd: params.workingDirectory ?? process.cwd(), sessionId,
                                    image: browserMediaToStructuredImageInput(media),
                                    maxBytes: configuration.filesUploadMaxFileBytes,
                                });
                                if (verified.status !== 'verified') throw new BrowserMediaUnavailableError();
                                images.push({ type: 'image', data: verified.bytes.toString('base64'), mimeType: verified.mimeType });
                            }
                        }
                        if (typeof requestedActionId === 'string' && requestedActionId.trim() === 'computer.capture') {
                            const capture = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
                                ? result.result as Record<string, unknown> : null;
                            if (capture?.status === 'captured') {
                                const media = SessionImageMediaReferenceV1Schema.safeParse(capture.media);
                                if (!media.success) throw new SessionMediaUnavailableError();
                                if (!params.sessionId) throw new SessionMediaUnavailableError();
                                const verified = await verifySessionStructuredImageInput({
                                    cwd: params.workingDirectory ?? process.cwd(), sessionId: params.sessionId,
                                    image: sessionMediaToStructuredImageInput(media.data),
                                    maxBytes: configuration.filesUploadMaxFileBytes,
                                });
                                if (verified.status !== 'verified') throw new SessionMediaUnavailableError();
                                images.push({ type: 'image', data: verified.bytes.toString('base64'), mimeType: verified.mimeType });
                            }
                        }
                        return {
                            content: [{ type: 'text' as const, text: stringifyMcpToolTextPayload(result.result) },
                                ...(result.automationNotices?.length ? [{ type: 'text' as const,
                                    text: stringifyMcpToolTextPayload({ automationNotices: result.automationNotices }) }] : []),
                                ...images],
                            ...(tool.outputSchema === undefined ? {} : {
                                // The MCP wire contract requires an object even though
                                // Action dispatch can return arbitrary JSON values.
                                structuredContent: CallToolResultSchema.shape.structuredContent.unwrap().parse(result.result),
                            }),
                            isError: false as const,
                        };
                    }

                    return formatHappierMcpToolFailure(result);
                } catch (error) {
                    const errorText = error instanceof Error ? error.message : String(error);
                    let payload = '{"errorCode":"tool_failed","error":"tool_failed"}';
                    try {
                        payload = JSON.stringify({ errorCode: error instanceof SessionMediaUnavailableError ? error.code : 'tool_failed', error: errorText });
                    } catch {
                        // ignore
                    }
                    return {
                        content: [{ type: 'text' as const, text: payload }],
                        isError: true as const,
                    };
                } finally {
                    stopProgressKeepalive();
                }
            },
        );
    }

    return { toolNames: enabledTools.map((tool) => tool.name) };
}
