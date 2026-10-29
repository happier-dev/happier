import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceProfileIdSchema,
} from '@happier-dev/protocol';
import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

export const CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH =
  '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh';
export const CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID = 'openai-codex';

export const CodexChatGptAuthTokensRefreshSelectionSchema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: z.literal(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID),
    profileId: ConnectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: z.literal(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID),
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
  }),
]));

export type CodexChatGptAuthTokensRefreshSelection =
  z.infer<typeof CodexChatGptAuthTokensRefreshSelectionSchema>;

export const CodexChatGptAuthTokensRefreshResponseSchema = lazySchema(() => z.object({
  accessToken: z.string().min(1),
  chatgptAccountId: z.string().nullable(),
  chatgptPlanType: z.string().nullable(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
  selectionEpoch: z.number().int().nonnegative().optional(),
  selection: CodexChatGptAuthTokensRefreshSelectionSchema.optional(),
}));

export type CodexChatGptAuthTokensRefreshResponse =
  z.infer<typeof CodexChatGptAuthTokensRefreshResponseSchema>;

export function resolveCodexChatGptAuthTokensRefreshProfileId(
  selection: CodexChatGptAuthTokensRefreshSelection,
): string {
  return selection.kind === 'group' ? selection.activeProfileId : selection.profileId;
}
