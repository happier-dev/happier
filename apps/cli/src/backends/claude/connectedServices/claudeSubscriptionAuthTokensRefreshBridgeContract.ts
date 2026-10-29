import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
} from '@happier-dev/protocol';
import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

/**
 * Daemon access-token bridge for the OpenCode Claude broker plugin. Sibling of the Codex
 * `chatgpt-auth-tokens/refresh` bridge. The broker (running in OpenCode's Bun runtime) POSTs here to
 * obtain a fresh Anthropic ACCESS token; the daemon remains the SOLE refresher and only the access
 * token (never the refresh token) leaves the daemon.
 */
export const CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH =
  '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh';
export const CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID = 'claude-subscription';

export const ClaudeSubscriptionAuthTokensRefreshSelectionSchema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: z.literal(CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID),
    profileId: ConnectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: z.literal(CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID),
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
  }),
]));

export type ClaudeSubscriptionAuthTokensRefreshSelection =
  z.infer<typeof ClaudeSubscriptionAuthTokensRefreshSelectionSchema>;

export const ClaudeSubscriptionAuthTokensRefreshResponseSchema = lazySchema(() => z.object({
  accessToken: z.string().min(1),
  anthropicAccountId: z.string().nullable(),
  expiresAt: z.number().nullable(),
  selectionEpoch: z.number().int().nonnegative().optional(),
}));

export type ClaudeSubscriptionAuthTokensRefreshResponse =
  z.infer<typeof ClaudeSubscriptionAuthTokensRefreshResponseSchema>;

export function resolveClaudeSubscriptionAuthTokensRefreshProfileId(
  selection: ClaudeSubscriptionAuthTokensRefreshSelection,
): string {
  return selection.kind === 'group' ? selection.activeProfileId : selection.profileId;
}
