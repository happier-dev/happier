import {
  formatPermissionRequestSummary,
  type PermissionRequestSummaryLabels,
} from '@happier-dev/protocol/activity/agentRequestSummary';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

import { formatMCPTitle } from '@/components/tools/renderers/system/MCPToolView';
import { t } from '@/text';

type PendingRequestTool = Readonly<{
  toolName: string;
  toolInput: unknown;
  mcpTool?: ResolvedMcpToolIdentityV1;
}>;

/**
 * The name app surfaces give a pending request's tool when its protocol name is a raw id: an MCP
 * tool, including a Happier Action call, reads by the title its request card shows (the Action's
 * translated title, or the MCP tool and server). Other tools return null, so the request summary
 * owner keeps their normalized name. Footer summary, pending list, activity overlay and Voice
 * read it here.
 */
export function resolveRequestToolLabel(
  request: PendingRequestTool,
): string | null {
  const toolName = request.toolName.trim();
  return toolName.startsWith('mcp__')
    ? formatMCPTitle(toolName, request.mcpTool, request.toolInput)
    : null;
}

const PERMISSION_SUMMARY_LABELS: PermissionRequestSummaryLabels = {
  required: (tool) => t('tools.common.permissionSummary.required', { tool }),
  requiredWithoutDetails: (tool) =>
    t('tools.common.permissionSummary.requiredWithoutDetails', { tool }),
  run: (command) => t('tools.common.permissionSummary.run', { command }),
  read: (path) => t('tools.common.permissionSummary.read', { path }),
  write: (path) => t('tools.common.permissionSummary.write', { path }),
  edit: (path) => t('tools.common.permissionSummary.edit', { path }),
};

/**
 * A pending permission request in one line, in the viewer's language. The Protocol owner decides
 * the line's shape; the app supplies the tool's name and the translations.
 */
export function formatPermissionRequestDisplaySummary(
  request: PendingRequestTool &
    Readonly<{
      /** Already resolved by `resolveRequestToolLabel` for this request. */
      toolLabel?: string | null;
    }>,
): string {
  return formatPermissionRequestSummary({
    toolName: request.toolName,
    toolInput: request.toolInput,
    toolLabel:
      request.toolLabel === undefined
        ? resolveRequestToolLabel(request)
        : request.toolLabel,
    labels: PERMISSION_SUMMARY_LABELS,
  });
}
