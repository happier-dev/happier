import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isPluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { parsePluginHostActionInvocation } from '@happier-dev/plugin-sdk/actions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { resolveHappierMcpServerConfig } from '@/agent/runtime/createHappierMcpBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { registerSessionMcpEndpointSession } from '@/mcp/runtime/sessionMcpHostEndpoint';
import { serveSessionMcpRelayUpgrade } from '@/mcp/runtime/sessionMcpRelayEndpoint';
import { createStatelessMcpRequestHandler } from '@/mcp/runtime/statelessMcpRequestHandler';
import type { HostAgentNativeMcpPlacement } from '@/plugins/runtime/invocation/services/exec';

/** Present the Run's existing invocation Actions; the endpoint never grants authority. */
export async function createNativeRunHappierMcpBridge(input: Readonly<{
    services: PluginServices;
    placement: HostAgentNativeMcpPlacement;
    signal: AbortSignal;
    directory: string;
    machineId: string;
}>) {
    const bridge = createActionToolExecutorBridge({
        executor: {
            async execute(actionId, rawInput, context) {
                try {
                    const contribution = parseQualifiedPluginActionId(actionId);
                    if (contribution) return { ok: true, result: await input.services.actions.execute(contribution,
                        StrictJsonValueSchema.parse(rawInput), { signal: context.signal ?? input.signal }) };
                    const request = parsePluginHostActionInvocation(actionId, rawInput);
                    return { ok: true, result: await input.services.actions.execute(request.actionId, request.input,
                        { signal: context.signal ?? input.signal }) };
                } catch (error) {
                    if (!isPluginError(error)) throw error;
                    return { ok: false, errorCode: error.code, error: error.message, details: error.data.details };
                }
            },
        },
        surface: 'agent', defaultSessionMachineId: input.machineId, defaultSessionRootPath: input.directory,
    });
    const createServer = (signal: AbortSignal) => {
        const mcp = new McpServer({ name: 'Happier', version: '1.0.0' });
        registerHappierMcpBuiltInTools(mcp, {
            surface: 'agent', workingDirectory: input.directory, sessionMachineId: input.machineId,
            deps: {
                ...bridge,
                resolveActionOptions: args => bridge.resolveActionOptions(args, undefined),
                changeTitle: async () => ({ success: false, errorCode: 'session_not_selected' }),
                executeActionByToolName: (name, args, sessionId, options) => bridge.executeActionByToolName(name, args, sessionId,
                    { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal }),
            },
        });
        return mcp;
    };
    const requests = createStatelessMcpRequestHandler({ signal: input.signal, createServer });
    const registration = await registerSessionMcpEndpointSession(input.placement.kind === 'prepared' ? input.placement.localTransport : undefined, {
        // Unique per Run registration. No ambient Session holder tree is admitted.
        holderScope: Object.freeze({}),
        handleRequest: requests.handleRequest,
        handleUpgrade: (request, socket, head) => serveSessionMcpRelayUpgrade(request, socket, head, {
            // The canonical endpoint already selected this exact registration.
            admit: async () => !input.signal.aborted,
            createRequestServer: async () => createServer(input.signal), lifetimeSignal: input.signal,
        }),
    });
    try {
        return {
            readContext: () => registration.localContext,
            mcpServer: resolveHappierMcpServerConfig(registration),
            async dispose() { await registration.retire(); await requests.dispose(); },
        };
    } catch (error) {
        await registration.retire();
        await requests.dispose();
        throw error;
    }
}
