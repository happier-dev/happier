import { z } from 'zod';

// Released account-profile readers have a closed service enum. Opt in before
// exposing Antigravity rows on the shared HTTP account projection.
export const ANTIGRAVITY_ACCOUNT_PROFILE_ACCEPT = 'application/json; happier-connected-service-antigravity=1';

// Scope is deliberately absent: oauth.scope alone records the provider's grant.
export const AntigravityOauthCredentialMetadataSchema = z.object({
    clientId: z.string().trim().min(1),
    authMethod: z.literal('oauth-personal'),
    projectId: z.string().trim().min(1).optional(),
    tierId: z.string().trim().min(1).optional(),
});

export type AntigravityOauthCredentialMetadata = Readonly<
    z.infer<typeof AntigravityOauthCredentialMetadataSchema>
>;
