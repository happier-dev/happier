import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Daemon access-token bridge schema for the OpenCode Claude broker plugin. Sibling of the Codex
 * bridge schemas (`@happier-dev/plugins-codex/.../openai/cloud/refreshBridge`).
 * The broker (running in OpenCode's Bun runtime) POSTs here to obtain a fresh Anthropic ACCESS token;
 * the daemon remains the SOLE refresher and only the access token (never the refresh token) leaves the
 * daemon.
 */
export const ClaudeSubscriptionAuthTokensRefreshSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: z.literal('claude-subscription'),
    profileId: ConnectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: z.literal('claude-subscription'),
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
  }),
]);

export type ClaudeSubscriptionAuthTokensRefreshSelection =
  z.infer<typeof ClaudeSubscriptionAuthTokensRefreshSelectionSchema>;

export const ClaudeSubscriptionAuthTokensRefreshResponseSchema = z.object({
  accessToken: z.string().min(1),
  anthropicAccountId: z.string().nullable(),
  expiresAt: z.number().nullable(),
});

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
