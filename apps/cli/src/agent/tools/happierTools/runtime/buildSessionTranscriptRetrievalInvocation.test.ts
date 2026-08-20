import { describe, expect, it } from 'vitest';

import { buildSessionTranscriptRetrievalInvocation } from './buildSessionTranscriptRetrievalInvocation';

/**
 * The replay seed tells the target Agent how to read the history it could not
 * inline. Printing the WRONG channel is not a degraded instruction but a false
 * one: the two channels are mutually exclusive at runtime, so an Agent handed
 * the other one's syntax cannot reach the transcript at all.
 */
describe('buildSessionTranscriptRetrievalInvocation', () => {
  const base = { sessionId: 'sess_1', directory: '/home/u/project' };

  it('renders the action_execute form for a native_mcp Agent, paging backwards from the cursor', () => {
    const render = buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'claude' });
    expect(render).not.toBeNull();
    const rendered = render!(4_200);
    expect(rendered.startsWith('action_execute ')).toBe(true);
    const payload = JSON.parse(rendered.slice('action_execute '.length)) as {
      actionId: string;
      input: Record<string, unknown>;
    };
    expect(payload.actionId).toBe('session.transcript.get');
    // `direction` is absent from the action's input hints and MCP example, so an
    // Agent left to discover the API pages forward from the start of the
    // session. Stating it is the whole point of rendering the call.
    expect(payload.input).toMatchObject({
      sessionId: 'sess_1',
      direction: 'before',
      cursor: '4200',
      limit: 100,
    });
    expect(payload.input.limit).toBeLessThanOrEqual(100);
  });

  it('omits the cursor when there is no anchor yet, so the first page is the newest one', () => {
    const render = buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'claude' })!;
    const payload = JSON.parse(render(null).slice('action_execute '.length)) as { input: { cursor: unknown } };
    expect(payload.input.cursor).toBeNull();
  });

  it('renders the CLI bridge form for a shell_bridge Agent, by the tool name the catalog binds', () => {
    const render = buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'cursor' });
    expect(render).not.toBeNull();
    const rendered = render!(4_200);
    expect(rendered).toContain("'tools' 'call'");
    expect(rendered).toContain("'--tool' 'session_transcript_get'");
    expect(rendered).toContain("'--session-id' 'sess_1'");
    expect(rendered).toContain("'--directory' '/home/u/project'");
    expect(rendered).toContain('"direction":"before"');
    expect(rendered).toContain('"cursor":"4200"');
    expect(rendered.startsWith('action_execute')).toBe(false);
  });

  it('renders nothing for an Agent the catalog does not hand Happier tools', () => {
    expect(buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'not-an-agent' })).toBeNull();
  });

  it('renders nothing without a session to point at', () => {
    expect(buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'claude', sessionId: '  ' })).toBeNull();
  });
});
