import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isPluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { parsePluginHostActionInvocation } from '@happier-dev/plugin-sdk/actions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { actionInputIssueFailure, actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { z } from 'zod/mini';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierActionIngressExecutor } from '@/agent/permissions/happierActionPermission';
import { resolveHappierMcpServerConfig } from '@/agent/runtime/createHappierMcpBridge';
import { sessionMcpAgentLaunchContextFile } from '@/daemon/agentIsolation/agentLaunchMaterials';
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
    sessionWorkspace?: WorkspaceAddressV1 | null;
    readPermission: Parameters<typeof createHappierActionIngressExecutor>[0]['readPermission'];
}>) {
    const bridge = createActionToolExecutorBridge({
        executor: createHappierActionIngressExecutor({
          readPermission: input.readPermission,
          executor: {
            async execute(actionId, rawInput, context) {
                try {
                    // Input refusals use the Action executor's content-free repair envelope,
                    // the answer a Session's Agent gets for the same input; never rejected values.
                    const contribution = parseQualifiedPluginActionId(actionId);
                    if (contribution) {
                        const json = StrictJsonValueSchema.safeParse(rawInput);
                        if (!json.success) return actionInputValidationFailure(json.error);
                        return { ok: true, result: await input.services.actions.execute(contribution,
                            json.data, { signal: context?.signal ?? input.signal }) };
                    }
                    if (!PluginInvocableActionIdSchema.safeParse(actionId).success) {
                        return actionInputIssueFailure({ code: 'unknown_action', path: ['actionId'] });
                    }
                    let request: ReturnType<typeof parsePluginHostActionInvocation>;
                    try {
                        request = parsePluginHostActionInvocation(actionId, rawInput);
                    } catch (error) {
                        if (error instanceof z.core.$ZodError) return actionInputValidationFailure(error);
                        throw error;
                    }
                    return { ok: true, result: await input.services.actions.execute(request.actionId, request.input,
                        { signal: context?.signal ?? input.signal }) };
                } catch (error) {
                    if (!isPluginError(error)) throw error;
                    return { ok: false, errorCode: error.code, error: error.message, details: error.data.details };
                }
            },
          },
        }),
        surface: 'agent', defaultSessionMachineId: input.machineId, defaultSessionRootPath: input.directory,
        defaultSessionWorkspace: input.sessionWorkspace,
    });
    const createServer = (signal: AbortSignal) => {
        const mcp = new McpServer({ name: 'Happier', version: '1.0.0' });
        registerHappierMcpBuiltInTools(mcp, {
            surface: 'agent', workingDirectory: input.directory, sessionMachineId: input.machineId,
            sessionWorkspace: input.sessionWorkspace,
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
        const prepared = input.placement.kind === 'prepared' ? input.placement : undefined;
        // A cross-UID endpoint has no daemon context file. Name the same Run
        // material the native launch publishes for the provider's child.
        const relay = prepared ? { localContext: registration.localContext,
            contextFilePath: sessionMcpAgentLaunchContextFile(prepared.runtimeHome) } : registration;
        return {
            readContext: () => registration.localContext,
            mcpServer: resolveHappierMcpServerConfig(relay, prepared?.managedHappierBinaryPath),
            async dispose() { await registration.retire(); await requests.dispose(); },
        };
    } catch (error) {
        await registration.retire();
        await requests.dispose();
        throw error;
    }
}
