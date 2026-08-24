import { SESSION_TRANSCRIPT_GET_MAX_LIMIT, getActionSpec } from '@happier-dev/protocol';

import { buildHappierToolsShellBridgeCommand } from './buildHappierToolsShellBridgeCommand';
import { resolveAgentToolsDelivery } from './resolveAgentToolsDelivery';

/**
 * The transcript reader the replay seed points a target Agent at. Named through
 * the action catalog so the tool name, the surface it is exposed on, and the
 * invocation printed into a prompt cannot drift apart.
 */
const SESSION_TRANSCRIPT_ACTION_ID = 'session.transcript.get';

/**
 * The value `session.transcript.get` gives its backwards page. A target reading
 * the history it is missing wants the newest rows first and then older ones, so
 * this is the direction the printed call has to name.
 *
 * The word is CHECKED against the option space the action declares rather than
 * simply written down. It cannot be read out of the spec instead of named,
 * because neither half of the spec can carry a chosen value: `inputHints` is a
 * form descriptor that says which values exist, not which one a caller should
 * send, and the input schema cannot default it either — that schema is shared
 * with the closed `externalShareableV1` projection, which rejects every key
 * outside its four, so a `.default()` would make that projection reject its own
 * canonical input. Naming it here and resolving it there is the closest the
 * seam allows, and it turns a renamed option into a dropped parameter rather
 * than a rejected call.
 */
const BACKWARDS_TRANSCRIPT_DIRECTION = 'before';

/**
 * The declared direction, or `null` when the catalog no longer offers it.
 *
 * Omitting beats guessing: the reader still pages backwards by default, so a
 * call without `direction` stays correct while a call naming a retired value is
 * rejected outright — and this instruction is read at the one moment the target
 * has no other way back to the history.
 */
function readDeclaredBackwardsDirection(): string | null {
  const declared = getActionSpec(SESSION_TRANSCRIPT_ACTION_ID)
    .inputHints?.fields.find((field) => field.path === 'direction');
  return (declared?.options ?? []).some((option) => option.value === BACKWARDS_TRANSCRIPT_DIRECTION)
    ? BACKWARDS_TRANSCRIPT_DIRECTION
    : null;
}

function buildTranscriptPageInput(sessionId: string, cursorSeq: number | null): Record<string, unknown> {
  const direction = readDeclaredBackwardsDirection();
  return {
    sessionId,
    ...(direction === null ? {} : { direction }),
    cursor: cursorSeq === null ? null : String(cursorSeq),
    // The action's own ceiling, named at the schema that enforces it. Asking for
    // more is rejected; asking for less makes the target page more times than it
    // has to.
    limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT,
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
 * is given the appendix and an empty MCP server map.
 *
 * `null` for an Agent the host hands NO Happier tools (`delivery: 'unsupported'`
 * — antigravity and the review-only Agents today). That is the same catalog
 * declaration the runtime gates both channels on, so a pointer here would tell
 * the target to run something it was never given; flipping such an Agent's
 * declaration is a change at that catalog, and this owner follows it for free.
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

  if (delivery === 'native_mcp' || delivery === 'native_extension') {
    // `session_transcript_get` is exposed to the in-session `agent` surface as
    // `discoverable_only`, so the direct tool name is NOT callable there; the
    // agent surface reaches it through the `action_execute` manual tool.
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
