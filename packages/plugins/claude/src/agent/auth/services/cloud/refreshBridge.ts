import { createHash } from 'node:crypto';
import { z } from 'zod/mini';

const connectedServiceProfileIdSchema = z.lazy(() => z.string().check(z.minLength(1)));
const connectedServiceAuthGroupIdSchema = z.lazy(() => z.string().check(z.trim(), z.minLength(1)));

/**
 * Daemon access-token bridge schema for the OpenCode Claude broker plugin. Sibling of the Codex
 * bridge schemas (`@happier-dev/plugins-codex/.../openai/cloud/refreshBridge`).
 * The broker (running in OpenCode's Bun runtime) POSTs here to obtain a fresh Anthropic ACCESS token;
 * the daemon remains the SOLE refresher and only the access token (never the refresh token) leaves the
 * daemon.
 */
export const ClaudeSubscriptionAuthTokensRefreshSelectionSchema = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: z.literal('claude-subscription'),
    profileId: connectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: z.literal('claude-subscription'),
    groupId: connectedServiceAuthGroupIdSchema,
    activeProfileId: connectedServiceProfileIdSchema,
    fallbackProfileId: connectedServiceProfileIdSchema,
    generation: z.number().check(z.int(), z.nonnegative()),
  }),
]));

export type ClaudeSubscriptionAuthTokensRefreshSelection =
  z.infer<typeof ClaudeSubscriptionAuthTokensRefreshSelectionSchema>;

export const ClaudeSubscriptionAuthTokensRefreshResponseSchema = z.lazy(() => z.object({
  accessToken: z.string().check(z.minLength(1)),
  anthropicAccountId: z.nullable(z.string()),
  expiresAt: z.nullable(z.number()),
}));

export type ClaudeSubscriptionAuthTokensRefreshResponse =
  z.infer<typeof ClaudeSubscriptionAuthTokensRefreshResponseSchema>;

export function resolveClaudeSubscriptionAuthTokensRefreshProfileId(
  selection: ClaudeSubscriptionAuthTokensRefreshSelection,
): string {
  return selection.kind === 'group' ? selection.activeProfileId : selection.profileId;
}

export function computeClaudeSubscriptionAccessTokenFingerprint(accessToken: string | null | undefined): string | null {
  const trimmed = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed, 'utf8').digest('base64url').slice(0, 32);
}
