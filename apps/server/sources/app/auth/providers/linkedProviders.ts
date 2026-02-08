import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";
import type { LinkedProvider } from "@happier-dev/protocol";

export type { LinkedProvider } from "@happier-dev/protocol";

export async function fetchLinkedProvidersForAccount(params: {
    tx: {
        accountIdentity: {
            findMany: (args: any) => Promise<
                Array<{
                    provider: string;
                    providerLogin: string | null;
                    profile: unknown;
                    showOnProfile: boolean;
                }>
            >;
        };
    };
    accountId: string;
}): Promise<LinkedProvider[]> {
    const identities = await params.tx.accountIdentity.findMany({
        where: { accountId: params.accountId },
        select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
        orderBy: { provider: "asc" },
    });

    return identities.map((identity) => {
        const providerId = identity.provider.toString().trim().toLowerCase();
        const providerLogin = identity.providerLogin ?? null;
        const provider = findIdentityProviderById(process.env, providerId);
        const extracted = provider?.extractLinkedProvider
            ? provider.extractLinkedProvider({ profile: identity.profile, providerLogin })
            : { displayName: null, avatarUrl: null, profileUrl: null };

        return {
            id: providerId,
            login: providerLogin,
            displayName: extracted.displayName,
            avatarUrl: extracted.avatarUrl,
            profileUrl: extracted.profileUrl,
            showOnProfile: Boolean(identity.showOnProfile),
        };
    });
}
