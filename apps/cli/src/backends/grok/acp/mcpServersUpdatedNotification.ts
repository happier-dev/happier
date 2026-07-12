import { z } from 'zod';

import type {
  AcpExtensionHandlerContext,
  AcpExtensionNotificationHandler,
} from '@/agent/acp/AcpBackend';

export const GROK_MCP_SERVERS_UPDATED_METHOD = '_x.ai/mcp/servers_updated' as const;

const MAX_MCP_SERVERS = 128;
const MAX_MCP_SERVER_ARGS = 128;
const MAX_MCP_SERVER_STRING_LENGTH = 16_384;

const NonEmptyExactIdentifier = z.string()
  .max(512)
  .refine((value) => value.length > 0 && value === value.trim(), 'must be a non-empty exact identifier');

const GrokMcpServerUpdateEntrySchema = z.object({
  name: NonEmptyExactIdentifier,
  source: z.string().max(512).optional(),
  type: z.string().max(128).optional(),
  command: z.string().max(MAX_MCP_SERVER_STRING_LENGTH).optional(),
  args: z.array(z.string().max(MAX_MCP_SERVER_STRING_LENGTH))
    .max(MAX_MCP_SERVER_ARGS)
    .optional(),
})
  // The notification is status-only and is never persisted. Validate the stable
  // identity and observed stdio fields while discarding future provider metadata.
  .strip();

const GrokMcpServersUpdatedPayloadSchema = z.object({
  mcpServers: z.array(GrokMcpServerUpdateEntrySchema).max(MAX_MCP_SERVERS),
}).strict();

export class GrokMcpServersUpdatedNotificationError extends Error {
  readonly name = 'GrokMcpServersUpdatedNotificationError';
  readonly code = 'GROK_MCP_SERVERS_UPDATED_INVALID';
}

export const handleGrokMcpServersUpdatedNotification: AcpExtensionNotificationHandler = (
  rawParams: Record<string, unknown>,
  context: AcpExtensionHandlerContext,
): void => {
  if (context.method !== GROK_MCP_SERVERS_UPDATED_METHOD) {
    throw new GrokMcpServersUpdatedNotificationError('Unsupported Grok MCP server update notification method');
  }

  const parsed = GrokMcpServersUpdatedPayloadSchema.safeParse(rawParams);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new GrokMcpServersUpdatedNotificationError(
      `Invalid Grok MCP server update notification: ${location}${issue?.message ?? 'payload validation failed'}`,
    );
  }

  // The ACP session/new request remains the sole owner of Happier's MCP state.
  // Grok emits this provider-status notification during initialize; acknowledging it
  // prevents protocol noise without importing provider state into the shared runtime.
};
