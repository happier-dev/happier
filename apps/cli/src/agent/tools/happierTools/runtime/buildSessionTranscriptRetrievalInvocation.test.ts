import { SESSION_TRANSCRIPT_GET_MAX_LIMIT, getActionSpec } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildSessionTranscriptRetrievalInvocation } from './buildSessionTranscriptRetrievalInvocation';

/**
 * The replay seed tells the target Agent how to read the history it could not
 * inline. Printing the WRONG channel is not a degraded instruction but a false
 * one: the two channels are mutually exclusive at runtime, so an Agent handed
 * the other one's syntax simply cannot reach the transcript at all.
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
    // The action clamps `limit` at 100; asking for more is rejected outright.
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
    // Discriminating: the MCP wrapper is the other channel's syntax.
    expect(rendered.startsWith('action_execute')).toBe(false);
  });

  it('renders nothing for an Agent the host hands no Happier tools', () => {
    // Both runtime channels are gated on this same catalog declaration, so a
    // pointer would name a tool this Agent was never given.
    expect(buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'antigravity' })).toBeNull();
  });

  it('renders nothing without a session to point at', () => {
    expect(buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'claude', sessionId: '  ' })).toBeNull();
  });

  /**
   * The invocation is an instruction ABOUT an action, so it drifts the moment
   * it transcribes that action's parameters instead of reading them. A stale
   * parameter is not a cosmetic defect here: the target Agent runs the printed
   * call at the one moment it is trying to recover context it does not have,
   * and a rejected call leaves it with nothing.
   *
   * These read the CURRENT spec rather than a copy of what it said when this
   * file was written, so changing the spec changes what is asserted.
   */
  describe('derives its parameters from the action spec', () => {
    const spec = getActionSpec('session.transcript.get');

    function renderedInput(cursorSeq: number | null): Record<string, unknown> {
      const rendered = buildSessionTranscriptRetrievalInvocation({ ...base, agentId: 'claude' })!(cursorSeq);
      return (JSON.parse(rendered.slice('action_execute '.length)) as { input: Record<string, unknown> }).input;
    }

    it('teaches a paging direction the catalog declares, so the two cannot disagree', () => {
      const declared = spec.inputHints?.fields.find((field) => field.path === 'direction');
      const offered = (declared?.options ?? []).map((option) => option.value);

      // Non-vacuous on both sides: the catalog has to offer the choice, and the
      // instruction has to make one. A spec that renames or drops the option
      // fails here instead of shipping a parameter the action would reject.
      expect(offered.length).toBeGreaterThan(0);
      expect(typeof renderedInput(4_200).direction).toBe('string');
      expect(offered).toContain(renderedInput(4_200).direction);
    });

    it('asks for the largest page the action allows, by the bound the action enforces', () => {
      expect(renderedInput(4_200).limit).toBe(SESSION_TRANSCRIPT_GET_MAX_LIMIT);
      // Discriminating: the constant is the enforced ceiling, not a number that
      // happens to match it today.
      expect(spec.inputSchema.safeParse({ sessionId: 'sess_1', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT }).success).toBe(true);
      expect(spec.inputSchema.safeParse({ sessionId: 'sess_1', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT + 1 }).success).toBe(false);
    });

    it('prints only parameters the action accepts, on the first page and on a later one', () => {
      expect(spec.inputSchema.safeParse(renderedInput(null)).success).toBe(true);
      expect(spec.inputSchema.safeParse(renderedInput(4_200)).success).toBe(true);
    });
  });
});
