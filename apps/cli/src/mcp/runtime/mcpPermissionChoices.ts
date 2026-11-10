import { randomUUID } from 'node:crypto';
import { createMcpCatalogPermissionChoiceV1, type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

/** The host's MCP permission producers support these existing decision outcomes. */
export function createMcpPermissionChoices(source: string, mcpTool: ResolvedMcpToolIdentityV1 | null): NativePermissionChoicesV1 {
  const sessionGrant = { id: 'approved_for_session', label: 'Allow for this session', decision: 'approved_for_session', scope: 'session',
    response: { approved: true, decision: 'approved_for_session' } } as const satisfies NativePermissionChoicesV1['choices'][number];
  const catalogGrant = createMcpCatalogPermissionChoiceV1({ mcpTool, grant: sessionGrant });
  return {
    requirementId: randomUUID(),
    source,
    choices: [
      { id: 'approved', label: 'Allow once', decision: 'approved', scope: 'once',
        response: { approved: true, decision: 'approved' } },
      sessionGrant,
      { id: 'denied', label: 'Deny', decision: 'denied', scope: 'once',
        response: { approved: false, decision: 'denied' } },
      { id: 'abort', label: 'Cancel', decision: 'abort', scope: 'once',
        response: { approved: false, decision: 'abort' } },
      ...(catalogGrant ? [catalogGrant] : []),
    ],
  };
}
