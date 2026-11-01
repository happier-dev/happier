import { createServer } from 'node:http';

/** Genuine external Anthropic HTTP boundary for isolated native-Claude regressions. */
export async function startAnthropicSseBoundary(options: Readonly<{
    firstToolCall?: Readonly<{ name: string; input: Record<string, unknown> }>;
}> = {}) {
    let toolCallSent = false;
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        if (request.url?.includes('count_tokens')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ input_tokens: 1 }));
            return;
        }
        if (!request.url?.includes('/v1/messages')) {
            response.writeHead(404);
            response.end('{}');
            return;
        }
        const input = JSON.parse(body) as { model: string };
        const message = { id: 'msg_local', type: 'message', role: 'assistant', model: input.model,
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const toolCall = !toolCallSent ? options.firstToolCall : undefined;
        if (toolCall) toolCallSent = true;
        const contentEvents = toolCall ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read-image-1', name: toolCall.name, input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.input) } },
        ] : [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local native test response.' } },
        ];
        for (const event of [
            { type: 'message_start', message },
            ...contentEvents,
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing localhost server address');
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}
