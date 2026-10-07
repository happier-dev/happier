import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

/**
 * How a first-party Happier Action reaches a transcript tool row.
 *
 * Every inline Action-result reference (a Board item, a managed workflow Run)
 * has to answer the same two questions before its own canonical parser runs:
 * which Action this tool call was, and which candidate payloads its recorded
 * result can be read as. Both answers are owned here once so a renamed binding
 * or a new result envelope cannot leave two references disagreeing.
 */

/**
 * How the first-party Happier tool surface spells its tools in a transcript.
 *
 * A tool from any other MCP server keeps its own server segment and therefore
 * never matches, so `mcp__othervendor__session_board_item_upsert` is not a Board
 * result even though its trailing segment collides.
 */
const HAPPIER_TOOL_NAME_PREFIXES = Object.freeze(['mcp__happier__', 'happier__', 'happier_']);

/**
 * Canonical tool bindings for one family of Actions.
 *
 * Built from the Action spec owner rather than spelled out by the caller, so a
 * renamed binding cannot leave a projection matching a name that no longer
 * exists.
 */
export function createHappierActionToolNameIndex<TActionId extends string>(
    actionIds: readonly TActionId[],
): ReadonlyMap<string, TActionId> {
    return new Map(actionIds.flatMap((actionId) => {
        // Family id unions are declared beside their own specs; every member is
        // a registered Action id, which is what the spec owner keys by.
        const toolName = getActionSpec(actionId as ActionId).bindings?.mcpToolName?.trim();
        return toolName ? [[toolName, actionId] as const] : [];
    }));
}

export function readHappierActionId<TActionId extends string>(
    toolName: string,
    index: ReadonlyMap<string, TActionId>,
): TActionId | null {
    const name = toolName.trim();
    if (!name) return null;
    const direct = index.get(name);
    if (direct) return direct;
    const firstParty = readFirstPartyHappierToolName(name);
    return firstParty ? index.get(firstParty) ?? null : null;
}

/** The first-party tool name without its Happier server prefix, or null for any other server. */
function readFirstPartyHappierToolName(toolName: string): string | null {
    for (const prefix of HAPPIER_TOOL_NAME_PREFIXES) {
        if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
    }
    return null;
}

/**
 * The Action a call of the generic first-party `action_execute` tool ran: its `input.actionId`, when
 * that names a member of the caller's family. A same-named tool from another MCP server is not the
 * Happier tool and names nothing.
 */
export function readHappierActionExecuteActionId<TActionId extends string>(
    toolName: string,
    input: unknown,
    isFamilyActionId: (actionId: string) => actionId is TActionId,
): TActionId | null {
    if (readFirstPartyHappierToolName(toolName.trim()) !== 'action_execute') return null;
    const parsed = maybeParseJson(input);
    if (!isRecord(parsed) || typeof parsed.actionId !== 'string') return null;
    const actionId = parsed.actionId.trim();
    return isFamilyActionId(actionId) ? actionId : null;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Join one MCP tool-result content array back into its single text payload.
 *
 * `registerHappierMcpBuiltInTools` writes exactly one `text` block holding
 * `JSON.stringify(result.result)`. Any block that is not a text block makes the
 * whole value not-an-MCP-result rather than something to scan.
 */
function readMcpToolResultText(value: unknown): string | null {
    const blocks = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value.content)
            ? value.content
            : null;
    if (!blocks || blocks.length === 0) return null;
    const texts: string[] = [];
    for (const block of blocks) {
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
        texts.push(block.text);
    }
    return texts.join('');
}

/**
 * The shapes a completed Happier Action result actually reaches the transcript
 * in. Each has a named producer; nothing else is inspected.
 *
 * 1. The bare Action result — the MCP text block above, already joined into a
 *    string by the transcript's own `toolResultContentToText` normalizer.
 * 2. The MCP tool-result envelope itself, for an Agent that recorded its
 *    structured `toolUseResult` instead of the joined text.
 * 3. The `{ ok, result }` executor envelope the direct Agent tool bridge returns.
 *
 * Each candidate is handed to the caller's canonical Protocol parser as-is; an
 * executor envelope is not unwrapped here because that parser owns the
 * difference between an applied result, a failure and a deferred approval.
 */
export function readHappierActionToolResultCandidates(result: unknown): readonly unknown[] {
    const parsed = maybeParseJson(result);
    const candidates: unknown[] = [parsed];
    if (isRecord(parsed) && parsed.structuredContent !== undefined) {
        candidates.push(parsed.structuredContent);
    }
    const text = readMcpToolResultText(parsed);
    if (text !== null) candidates.push(maybeParseJson(text));
    return candidates;
}
