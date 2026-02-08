import type { Context } from "@/context";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";

export type IdentityProvider = Readonly<{
    id: string;
    connect: (params: {
        ctx: Context;
        profile: unknown;
        accessToken: string;
        refreshToken?: string;
        preferredUsername?: string | null;
    }) => Promise<void>;
    disconnect: (params: { ctx: Context }) => Promise<void>;
    enforceLoginEligibility?: (params: {
        accountId: string;
        env: NodeJS.ProcessEnv;
        policy: AuthPolicy;
        now?: Date;
    }) => Promise<LoginEligibilityResult>;
    extractSocialProfile?: (params: { profile: unknown }) => { bio: string | null; suggestedUsername: string | null };
    extractLinkedProvider?: (params: {
        profile: unknown;
        providerLogin: string | null;
    }) => { displayName: string | null; avatarUrl: string | null; profileUrl: string | null };
    extractProfileBadge?: (params: {
        profile: unknown;
        providerLogin: string | null;
    }) => { label: string; url: string } | null;
}>;
