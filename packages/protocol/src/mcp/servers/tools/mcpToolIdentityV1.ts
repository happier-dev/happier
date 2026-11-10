import type { NativePermissionChoicesV1 } from '../../../sessions/permissions/nativeChoicesV1.js';
import type { McpToolAnnotationsV1 } from '../settingsV1.js';
import type { McpToolDecisionV1 } from './resolveMcpToolDecisionV1.js';
import { McpToolAnnotationsV1Schema } from '../settingsV1.js';
import { McpToolDecisionV1Schema } from './resolveMcpToolDecisionV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
export type McpToolIdentityV1 = Readonly<{ server: string; tool: string }>;
export type ResolvedMcpToolIdentityV1 = McpToolIdentityV1 & Readonly<{
  item: Readonly<{ serverId: string; plugin?: Readonly<{ pluginId: string; localId: string }> }>;
  serverTitle: string; toolTitle?: string; annotations?: McpToolAnnotationsV1; decision: McpToolDecisionV1;
}>;
export const ResolvedMcpToolIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  server: z.string().check(z.minLength(1)), tool: z.string().check(z.minLength(1)),
  item: z.strictObject({ serverId: z.string().check(z.minLength(1)), plugin: z.optional(z.strictObject({ pluginId: z.string().check(z.minLength(1)), localId: z.string().check(z.minLength(1)) })) }),
  serverTitle: z.string(), toolTitle: z.optional(z.string()), annotations: z.optional(McpToolAnnotationsV1Schema), decision: McpToolDecisionV1Schema,
}));
export function parseMcpToolWireNameV1(name: string, knownServerKeys: ReadonlySet<string>): McpToolIdentityV1 | null {
  if (!name.startsWith('mcp__')) return null;
  let longest: McpToolIdentityV1 | null = null;
  for (const server of knownServerKeys) {
    if (server === 'happier' || !server) continue;
    const prefix = `mcp__${server}__`;
    if (!name.startsWith(prefix)) continue;
    if (!longest || server.length > longest.server.length) longest = { server, tool: name.slice(prefix.length) };
  }
  return longest?.tool ? longest : null;
}

/** Preserve catalog consent while each native producer owns its grant payload. */
export function createMcpCatalogPermissionChoiceV1(input: Readonly<{
  mcpTool: ResolvedMcpToolIdentityV1 | null | undefined;
  grant: NativePermissionChoicesV1['choices'][number];
  existingChoices: readonly Pick<NativePermissionChoicesV1['choices'][number], 'id'>[];
}>): NativePermissionChoicesV1['choices'][number] | undefined {
  const { mcpTool, grant } = input;
  if (!mcpTool || mcpTool.server === 'happier') return undefined;
  const offeredIds = new Set(input.existingChoices.map(choice => choice.id));
  let id = 'mcp_always_allow';
  for (let suffix = 1; offeredIds.has(id); suffix += 1) id = `mcp_always_allow:${suffix}`;
  return {
    ...grant, id, label: 'Always allow', scope: 'localPersistent',
    followUp: { actionId: 'mcp.servers.tools.set', input: {
      serverId: mcpTool.item.serverId, tools: { [mcpTool.tool]: 'allow' },
    } },
  };
}
