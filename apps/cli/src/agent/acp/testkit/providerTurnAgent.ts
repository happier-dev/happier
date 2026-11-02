import { writeAcpTestAgentScript } from './subprocessHarness';

export function writeProviderTurnAgent(directory: string): string {
    return writeAcpTestAgentScript({
        dir: directory, fileName: 'provider-turns.mjs',
        source: `
            let buffer = '';
            let turn = 0;
            let closes = 0;
            let loads = 0;
            let holdClose = false;
            let closingRequest = null;
            const awaiting = new Map();
            const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
            const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
            const notify = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned', update } });
            process.stdin.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\\n'); buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const message = JSON.parse(line);
                    if (!message.method && awaiting.has(message.id)) {
                        ok(awaiting.get(message.id), message.result ?? { error: message.error });
                        awaiting.delete(message.id); continue;
                    }
                    if (message.method === 'initialize') ok(message.id, {
                        protocolVersion: 1, authMethods: [],
                        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
                    });
                    else if (message.method === 'session/new') ok(message.id, { sessionId: 'owned' });
                    else if (message.method === 'session/load') { loads++; ok(message.id, {}); }
                    else if (message.method === 'session/close') {
                        closes++;
                        if (holdClose) closingRequest = message.id;
                        else ok(message.id, {});
                    } else if (message.method === 'test/hold-close') { holdClose = true; ok(message.id, {}); }
                    else if (message.method === 'test/release-close') {
                        if (closingRequest !== null) ok(closingRequest, {});
                        closingRequest = null; holdClose = false; ok(message.id, {});
                    }
                    else if (message.method === 'session/prompt') {
                        const id = turn++ + ':background';
                        notify({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'fixture' } });
                        notify({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'started' });
                        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREGROUND' } });
                        ok(message.id, { stopReason: 'end_turn' });
                    } else if (message.method === 'test/late') {
                        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_FOREGROUND' } });
                        ok(message.id, {});
                    } else if (message.method === 'test/permission') {
                        awaiting.set('permission', message.id);
                        send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {
                            sessionId: message.params.sessionId ?? 'owned',
                            toolCall: { toolCallId: message.params.toolCallId, title: 'Bash', kind: 'execute', rawInput: { command: 'fixture' } },
                            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
                        } });
                    } else if (message.method === 'test/elicitation') {
                        awaiting.set('elicitation', message.id);
                        send({ jsonrpc: '2.0', id: 'elicitation', method: 'elicitation/create', params: {
                            mode: 'form', sessionId: 'owned', toolCallId: message.params.toolCallId,
                            message: 'Continue?', requestedSchema: { type: 'object', properties: {} },
                        } });
                    } else if (message.method === 'test/write' || message.method === 'test/read') {
                        const write = message.method === 'test/write';
                        awaiting.set('filesystem', message.id);
                        send({ jsonrpc: '2.0', id: 'filesystem', method: write ? 'fs/write_text_file' : 'fs/read_text_file', params: {
                            sessionId: message.params.sessionId ?? 'owned', path: message.params.path,
                            ...(write ? { content: 'fixture' } : {}),
                        } });
                    } else if (message.method === 'test/status') ok(message.id, { pid: process.pid, closes, loads });
                    else if (message.id !== undefined) ok(message.id, {});
                }
            });
        `,
    });
}
