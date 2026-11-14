import { createServer } from 'node:http';
import { json } from 'node:stream/consumers';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VoiceAgentManager } from '../../../../../cli/src/agent/voice/agent/VoiceAgentManager';
import { createNativeAgentSessionInteractionHostRuntime } from '../../../../../cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { createNativeSessionBoundary, createVoiceSessionContextLease } from '../../../../../cli/src/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema, type ActionId } from '@happier-dev/protocol/actions';

/** Script only the provider and client network boundary; host MCP and Action owners stay real. */
export async function createNativeVoiceActionHarness(execute: (
    actionId: ActionId, input: unknown, callId: string,
) => Promise<ActionExecuteResult>) {
    const boundaryFailures: Array<{ name: string; message: string }> = [];
    const bearerToken = crypto.randomUUID();
    const server = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${bearerToken}`) { response.writeHead(401).end(); return; }
        const mcp = new Server({ name: 'voice-client-boundary', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'action_execute', inputSchema: { type: 'object' as const } }] }));
        mcp.setRequestHandler(CallToolRequestSchema, async call => {
            const actionId = ActionIdSchema.parse(call.params.arguments?.actionId);
            const callId = call.params._meta?.['happier/action-request-id'];
            if (call.params.name !== 'action_execute' || typeof callId !== 'string')
                throw new Error('Missing native Action identity at the client boundary');
            const execution = await execute(actionId, call.params.arguments?.input, callId).catch(error => {
                boundaryFailures.push(error instanceof Error ? { name: error.name, message: error.message }
                    : { name: 'unknown', message: String(error) });
                throw error;
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(execution.ok ? execution.result : execution) }], isError: !execution.ok };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.once('close', () => { void transport.close(); void mcp.close(); });
        try {
            await mcp.connect(transport);
            await transport.handleRequest(request, response, request.method === 'POST' ? await json(request) : undefined);
        } catch { if (!response.headersSent) response.writeHead(500).end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing MCP listener');
    const native = createNativeSessionBoundary();
    const manager = new VoiceAgentManager({ createRuntime: options => createNativeAgentSessionInteractionHostRuntime({
        runtime: { sessions: { open: native.open } },
        lease: { pluginId: 'acme.voice', pluginVersion: '1', agentId: 'acme.voice/agents/default',
            localAgentId: 'default', occurrenceId: 'native-action-regression', isCurrent: () => true },
        sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
        createSessionContext: ({ services, signal }) => ({
            ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
            sessionMcpContext: { v: 1, url: `http://127.0.0.1:${address.port}`, bearerToken },
        }),
        options: { cwd: '/repo', runId: 'native-action-regression', backendId: 'acme.voice/agents/default',
            scope: 'session_owned', permissionMode: 'read_only', functionTools: options.functionTools,
            start: options.start },
    }) });
    return { manager, native, boundaryFailures, async dispose() {
        await manager.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
