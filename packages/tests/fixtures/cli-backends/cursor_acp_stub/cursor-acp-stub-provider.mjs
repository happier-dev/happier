#!/usr/bin/env node
// Sanitized deterministic Cursor ACP fixture. It contains only structural
// lifecycle data from the approved Phase 13 contract, never captured content.
let buffer = '';
const order = 'cmrrrrrsrsssrrrssrsssssssssbrrrrrrsbsssssbbsssrrrsbbbsssrrrsbrsrrbrsrrssssrrsreesrsbsrersebebbssrrrsrrrssrrrsrrssssrrrrrreeebreeeesessseebbssbbbbbbrbbssbrsbbrsrsorssssrssrsssrrsrsrrebreeberebebbbbborssrebesrebebbbbbebrssrsebbbrboeebebobbbbbbbbssrrrssrroosssrrrrrrsrssrrmo';

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function update(sessionId, value) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } }); }
function promptText(prompt) { return Array.isArray(prompt) ? prompt.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : ''; }

function replay(sessionId) {
  const counts = { c: 0, m: 0, r: 0, s: 0, b: 0, e: 0, o: 0 };
  for (const family of order) {
    const index = ++counts[family];
    const suffix = String(index).padStart(3, '0');
    if (family === 'o' && index === 7) {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'captured-create-plan-001', title: 'Create Plan', kind: 'other', status: 'pending', rawInput: { _toolName: 'createPlan' } });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'captured-create-plan-001', title: 'Create Plan', kind: 'other', status: 'in_progress', rawInput: { _toolName: 'createPlan' } });
      continue;
    }
    const kind = family === 'c' ? 'change_title' : family === 'm' ? 'switch_mode' : family === 'r' ? 'read' : family === 's' ? 'search' : family === 'b' ? 'execute' : family === 'e' ? 'edit' : 'other';
    const prefix = family === 'c' ? 'change-title' : family === 'm' ? 'switch-mode' : family === 'r' ? 'read' : family === 's' ? 'search' : family === 'b' ? 'bash' : family === 'e' ? 'edit' : 'task';
    const toolCallId = `captured-${prefix}-${suffix}`;
    const title = family === 'e' ? `Edit sanitized-${suffix}.txt` : family === 'o' ? `Task ${index}` : `${kind} sanitized ${suffix}`;
    if (family === 'r' && index === 1) {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, title, kind, status: 'completed', rawOutput: { path: `sanitized-${suffix}.txt`, text: 'sanitized' } });
      continue;
    }
    const rawInput = family === 'e'
      ? { path: `sanitized-${suffix}.txt` }
      : family === 'o'
        ? { _toolName: 'task', description: `Sanitized task ${index}` }
        : family === 'b'
          ? { command: ['printf', suffix] }
          : family === 'r'
            ? { path: `sanitized-${suffix}.txt` }
            : family === 's'
              ? { query: `sanitized-${suffix}` }
              : { value: `sanitized-${suffix}` };
    const rawOutput = family === 'o'
      ? { completed: true, task: index }
      : family === 'b'
        ? index === 56
          ? { error: 'sanitized failure' }
          : index === 57
            ? { cancelled: true }
            : { output: suffix }
        : family === 'r'
          ? { path: `sanitized-${suffix}.txt`, text: 'sanitized' }
          : family === 's'
            ? { totalMatches: index % 5, truncated: index % 11 === 0 }
            : { completed: true, value: suffix };
    const terminal = {
      sessionUpdate: 'tool_call_update', toolCallId, title, kind,
      status: family === 'b' && index >= 56 ? (index === 56 ? 'failed' : 'cancelled') : 'completed', rawOutput,
    };
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput });
    if (family === 'e') update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, title, kind, status: 'in_progress', rawInput: { path: `sanitized-${suffix}.txt`, old_string: 'before', new_string: 'after' } });
    update(sessionId, terminal);
    if (family === 'e' || (family === 'r' && index === 2)) update(sessionId, terminal);
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CURSOR_CAPTURED_REPLAY_DONE' } });
}

function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') return result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (method === 'session/new') return result(id, { sessionId: 'cursor-captured-replay-session' });
  if (method === 'session/load') return result(id, {});
  if (method === 'session/prompt') {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'cursor-captured-replay-session';
    if (promptText(params.prompt).includes('CURSOR_STUB_CAPTURED_REPLAY=1')) replay(sessionId);
    return result(id, { stopReason: 'end_turn' });
  }
  return result(id, {});
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* fixture protocol ignores malformed input */ }
  }
});
