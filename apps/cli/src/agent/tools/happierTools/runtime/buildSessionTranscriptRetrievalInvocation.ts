import { getActionSpec } from '@happier-dev/protocol';

import { buildHappierToolsShellBridgeCommand } from './buildHappierToolsShellBridgeCommand';
import { resolveAgentToolsDelivery } from './resolveAgentToolsDelivery';

/**
 * The transcript reader the replay seed points a target Agent at. Named through
 * the action catalog so the tool name, the surface it is exposed on, and the
 * invocation printed into a prompt cannot drift apart.
 */
const SESSION_TRANSCRIPT_ACTION_ID = 'session.transcript.get';

/**
 * The action's own per-request maximum (`SessionTranscriptGetInputSchema.limit`,
 * `z.number().int().min(1).max(100)`). Asking for more is rejected, and asking
 * for less would make the target page more times than it has to.
 */
const SESSION_TRANSCRIPT_PAGE_LIMIT = 100;

function buildTranscriptPageInput(sessionId: string, cursorSeq: number | null): Record<string, unknown> {
  return {
    sessionId,
    // `direction` defaults to `before` on the server, but it is absent from the
    // action's `inputHints` AND from its MCP example, so an Agent that discovers
    // the API from the catalog does not know backwards paging exists. It is
    // stated explicitly here for the same reason the prompt states it in prose.
    direction: 'before',
    cursor: cursorSeq === null ? null : String(cursorSeq),
    limit: SESSION_TRANSCRIPT_PAGE_LIMIT,
  };
}

/**
 * One ready-to-run invocation that reads a Session's transcript backwards,
 * rendered for the way THIS Agent is actually handed Happier tools.
 *
 * The delivery mode is read from the Agent catalog rather than assumed, because
 * the two channels are mutually exclusive at runtime and the wrong one is not a
 * degraded instruction but a false one: a `native_mcp` Agent is provisioned the
 * in-session MCP server and no shell-bridge appendix, and a `shell_bridge` Agent
 * is given the appendix and no MCP server.
 *
 * `null` for an Agent the host hands NO Happier tools. That is the same catalog
 * declaration the runtime gates both channels on, so a pointer here would tell
 * the target to run something it was never given.
 */
export function buildSessionTranscriptRetrievalInvocation(params: Readonly<{
  agentId: string;
  sessionId: string;
  directory: string;
}>): ((cursorSeq: number | null) => string) | null {
  const sessionId = params.sessionId.trim();
  if (!sessionId) return null;

  const delivery = resolveAgentToolsDelivery(params.agentId);
  if (delivery === 'unsupported') return null;

  if (delivery === 'native_mcp') {
    // `session.transcript.get` is exposed to the in-session `session_agent`
    // surface as `discoverable_only`, so the direct tool name is NOT callable
    // there; that surface reaches it through the `action_execute` manual tool.
    return (cursorSeq) => `action_execute ${JSON.stringify({
      actionId: SESSION_TRANSCRIPT_ACTION_ID,
      input: buildTranscriptPageInput(sessionId, cursorSeq),
    })}`;
  }

  const toolName = String(getActionSpec(SESSION_TRANSCRIPT_ACTION_ID).bindings?.mcpToolName ?? '').trim();
  if (!toolName) return null;
  return (cursorSeq) => buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    toolName,
    '--args-json',
    JSON.stringify(buildTranscriptPageInput(sessionId, cursorSeq)),
    '--json',
  ]);
}
