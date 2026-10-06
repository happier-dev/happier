import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { createPluginJsonSchemaZodObjectAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionId, ActionsSettingsV1, ApprovalRequestOriginV1, BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol';
import { BrowserScreenshotMediaReferenceV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { SessionImageMediaReferenceV1Schema } from '@happier-dev/protocol/sessions/media/imageReferenceV1';
import { createActionToolNameToIdMap } from '@/agent/tools/happierTools/actionToolCatalog';
import type { HappierBuiltInToolDefinition } from '@/agent/tools/happierTools/types';
import { z } from 'zod';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { projectSessionBoundActionToolInputSchema } from '@/agent/tools/happierTools/actionToolContext';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import {
    BrowserMediaUnavailableError,
    browserMediaToStructuredImageInput,
    SessionMediaUnavailableError,
    sessionMediaToStructuredImageInput,
    verifySessionStructuredImageInput,
} from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';

const MCP_TOOL_PROGRESS_KEEPALIVE_INTERVAL_MS = 15_000;

export type ToolRegistrar<TExtra = unknown> = Readonly<{
    registerTool: (name: string, meta: unknown, handler: (args: unknown, extra?: TExtra) => Promise<unknown>) => void;
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
    sessionId: string;
    toolName: string;
    extra: unknown;
}>): ApprovalRequestOriginV1 | null {
    if (params.surface !== 'agent') return null;
    const rawRequestId = (params.extra as { requestId?: unknown } | null | undefined)?.requestId;
    const requestId =
        typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
            ? String(rawRequestId).trim()
            : '';
    return {
        kind: 'transcript_tool_call',
        sessionId: params.sessionId,
        ...(requestId ? { toolCallId: requestId, mcpRequestId: requestId } : {}),
        toolName: params.toolName,
    };
}

function toMcpToolInputSchema(params: Readonly<{
    actionId: string | null | undefined;
    inputSchema: unknown;
    sessionId: string;
    sessionMachineId?: string | null;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): z.ZodType {
    const contextualInputSchema = params.actionId
        ? projectSessionBoundActionToolInputSchema({
            actionId: params.actionId,
            inputSchema: params.inputSchema,
            context: {
                defaultSessionId: params.sessionId,
                defaultSessionMachineId: params.sessionMachineId,
            },
            pluginToolCatalog: params.pluginToolCatalog,
        })
        : params.inputSchema;
    return toMcpToolObjectSchema(contextualInputSchema, 'inputSchema');
}

function toMcpToolObjectSchema(schema: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
    if (schema instanceof z.ZodType) {
        // Action schemas are executable parser contracts and can contain
        // normalization transforms that the MCP SDK cannot render. Present
        // the same canonical structural JSON Schema used by Action discovery
        // through a non-transforming Zod object adapter. Validation delegates
        // to the original schema, while dispatch retains the authoritative
        // parse/normalization rather than receiving MCP-transformed input.
        const jsonSchema = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' });
        const adapter = z.object({}).passthrough().superRefine((value, ctx) => {
            if (!schema.safeParse(value).success) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Value does not match the Action ${field}`,
                });
            }
        });
        adapter._zod.processJSONSchema = (_ctx, json) => {
            Object.assign(json, jsonSchema);
            json.type = 'object';
        };
        return adapter;
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error(`Plugin tool ${field} must be a JSON Schema object`);
    }

    // External plugin declarations use the protocol-owned bounded JSON Schema
    // vocabulary. The MCP SDK accepts Zod at registration, so use the protocol
    // owner's presentation adapter; daemon action execution remains the
    // authoritative validation and dispatch owner.
    return createPluginJsonSchemaZodObjectAdapter(schema);
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

function resolveMcpToolAnnotations(tool: HappierBuiltInToolDefinition): unknown {
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

export function registerHappierMcpBuiltInTools(
    server: ToolRegistrar,
    params: Readonly<{
        sessionId: string;
        workingDirectory?: string | null;
        sessionMachineId?: string | null;
        surface: BuiltInHappierToolsSurface;
        actionsSettings?: ActionsSettingsV1 | null;
        getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
        pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
        requiredDirectActionIds?: readonly ActionId[];
        deps: DispatchDeps;
        resolveSessionId?: (toolArgs: unknown) => string;
    }>,
): Readonly<{ toolNames: string[] }> {
    // This registrar intentionally exposes first-party built-in Happier tools.
    // Plugin-contributed direct tools use the ActionSpec/tool projection path.
    const isActionEnabled = params.deps.isActionEnabled ?? (() => true);
    const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
    const actionsSettings = readActionsSettings();
    const enabledTools = listBuiltInHappierTools({
        surface: params.surface,
        isActionEnabled,
        actionsSettings,
        pluginToolCatalog: params.pluginToolCatalog,
        requiredDirectActionIds: params.requiredDirectActionIds,
    });
    const actionToolNameToId = createActionToolNameToIdMap({
        surface: params.surface,
        isActionEnabled,
        actionsSettings,
        pluginToolCatalog: params.pluginToolCatalog,
        requiredDirectActionIds: params.requiredDirectActionIds,
    });

    for (const tool of enabledTools) {
        const actionId = actionToolNameToId.get(tool.name) ?? null;
        const pluginToolMcpMeta = buildPluginToolMcpMeta(tool);
        const annotations = resolveMcpToolAnnotations(tool);
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                title: tool.title,
                inputSchema: toMcpToolInputSchema({
                    actionId,
                    inputSchema: tool.inputSchema,
                    sessionId: params.sessionId,
                    sessionMachineId: params.sessionMachineId,
                    pluginToolCatalog: params.pluginToolCatalog,
                }),
                ...(tool.outputSchema === undefined ? {} : {
                    outputSchema: toMcpToolObjectSchema(tool.outputSchema, 'outputSchema'),
                }),
                ...(annotations === undefined ? {} : { annotations }),
                ...(pluginToolMcpMeta === undefined ? {} : { _meta: pluginToolMcpMeta }),
            },
            async (args: unknown, extra?: unknown) => {
                const stopProgressKeepalive = startMcpToolProgressKeepalive(extra);
                try {
                    const sessionId = params.resolveSessionId ? params.resolveSessionId(args) : params.sessionId;
                    const approvalOrigin = buildSessionAgentApprovalOrigin({
                        surface: params.surface,
                        sessionId,
                        toolName: tool.name,
                        extra,
                    });
                    const rawRequestId = (extra as { requestId?: unknown } | null | undefined)?.requestId;
                    const actionRequestId = typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
                        ? String(rawRequestId).trim()
                        : '';
                    const currentActionsSettings = readActionsSettings();
                    const result = await dispatchBuiltInHappierTool({
                        toolName: tool.name,
                        args,
                        sessionId,
                        sessionMachineId: params.sessionMachineId,
                        surface: params.surface,
                        actionsSettings: currentActionsSettings,
                        getActionsSettings: readActionsSettings,
                        pluginToolCatalog: params.pluginToolCatalog,
                        requiredDirectActionIds: params.requiredDirectActionIds,
                        ...(approvalOrigin ? { approvalOrigin } : {}),
                        ...(actionRequestId ? { actionRequestId } : {}),
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
                            content: [{ type: 'text' as const, text: stringifyMcpToolTextPayload(result.result) }, ...images],
                            ...(tool.outputSchema === undefined ? {} : { structuredContent: result.result }),
                            isError: false as const,
                        };
                    }

                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                errorCode: result.errorCode,
                                error: result.error,
                                ...(result.details === undefined ? {} : { details: result.details }),
                            }),
                        }],
                        isError: true as const,
                    };
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
