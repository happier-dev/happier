import { describe, expect, it } from 'vitest';
import { createHappierMcpToolNamingResolver } from '../../../../../../../apps/cli/src/mcp/runtime/projectMcpToolNames';
import { buildOpenCodeSessionMcpProjection } from './mcpRegistration.js';
import { createOpenCodeServerRuntimeState, readOpenCodeToolPart } from './state.js';
import { publishOpenCodeToolPartRuntimeEvents } from './toolEvents.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';

async function fixture() {
  const original = 'plugin_' + 'long_name_'.repeat(9);
  let waiting: Promise<void> | undefined;
  const resolve = createHappierMcpToolNamingResolver({ command: '/fixture' }, async () => {
    await waiting;
    return ['change_title', original];
  });
  const naming = (await resolve({ serverName: 'happier', toolNameMaxLength: 40 }))!;
  const mcpProjection = buildOpenCodeSessionMcpProjection('session-a', { happier: { command: '/fixture' } }, resolve, naming.aliasPrefix);
  const server = mcpProjection.registrations[0]!.projectedName;
  const part = readOpenCodeToolPart({ type: 'tool', sessionID: 'native-session', callID: 'call-1', messageID: 'message-1',
    tool: `${server}_${naming.tools[1]!.projectedName}`, state: { status: 'completed', input: {}, output: 'ok' } })!;
  const state = createOpenCodeServerRuntimeState();
  state.activeTurnId = 'turn-1'; state.turnInFlight = true;
  const events: OpenCodeRuntimeEvent[] = [];
  const args = { part, state, mcpProjection, scope: { kind: 'session' as const, sessionId: 'session-a' },
    publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => events.push(event) };
  return { args, events, server, original, defer: () => {
    let resume!: () => void; waiting = new Promise<void>(resolve => { resume = resolve; }); return resume;
  } };
}

describe('OpenCode tool-event identity publication', () => {
  it('publishes one canonical call then result when live and history observations overlap alias resolution', async () => {
    const f = await fixture(); const resume = f.defer();
    const live = publishOpenCodeToolPartRuntimeEvents(f.args);
    const history = publishOpenCodeToolPartRuntimeEvents(f.args);
    resume(); await Promise.all([live, history]);
    expect(f.events.map(event => event.kind)).toEqual(['tool-call', 'tool-result']);
    expect(f.events[0]).toMatchObject({ kind: 'tool-call', turnId: 'turn-1', toolName: `mcp__happier__${f.original}` });
  });

  it('does not publish or claim a previous turn after its alias resolution settles in a newer turn', async () => {
    const f = await fixture(); const resume = f.defer();
    const pending = publishOpenCodeToolPartRuntimeEvents(f.args);
    f.args.state.activeTurnId = 'turn-2';
    f.args.state.currentTurnPublishedToolCallKeys.clear();
    f.args.state.currentTurnPublishedToolCallKeys.add('new-turn-call');
    resume(); await pending;
    expect(f.events).toEqual([]);
    expect([...f.args.state.currentTurnPublishedToolCallKeys]).toEqual(['new-turn-call']);
    expect(f.args.state.currentTurnPublishedToolResultKeys.size).toBe(0);
  });

  it('publishes an ordinary name before yielding, keeping the existing atomic event path', async () => {
    const f = await fixture(); f.defer();
    const pending = publishOpenCodeToolPartRuntimeEvents({ ...f.args,
      part: { ...f.args.part, tool: `${f.server}_change_title`, state: { status: 'running', input: {} } } });
    expect(f.events).toMatchObject([{
      kind: 'tool-call', toolName: 'mcp__happier__change_title',
      toolCallId: 'call-1', turnId: 'turn-1', sessionId: 'session-a',
    }]);
    await pending;
  });
});
