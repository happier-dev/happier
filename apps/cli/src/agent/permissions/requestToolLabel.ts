import { getActionSpec } from '@happier-dev/protocol/actions';
import { readHappierActionCallId } from '@happier-dev/protocol/actions/happierActionCall';
import { resolveMcpToolTitle } from '@happier-dev/session-core/tools';

/**
 * The name CLI-authored request summaries (push notifications, remote mediation) give a pending
 * request's tool when its protocol name is a raw MCP id: a Happier Action's title, else the readable
 * MCP tool name. Other tools return null, so the request summary owner keeps their normalized name.
 * The app resolves the same name with translations (`resolveRequestToolLabel` in apps/ui).
 */
export function resolveRequestToolLabel(
  toolName: string,
  toolInput: unknown,
): string | null {
  const name = toolName.trim();
  if (!name.startsWith('mcp__')) return null;
  const actionId = readHappierActionCallId(name, toolInput);
  return resolveMcpToolTitle(
    name,
    undefined,
    actionId ? getActionSpec(actionId).title.trim() || null : null,
  );
}
