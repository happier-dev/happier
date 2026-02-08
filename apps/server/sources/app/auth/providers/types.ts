import type { FeaturesResponse } from "@/app/features/types";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { AuthProviderId } from "@happier-dev/protocol";

export type AuthProviderFeatures = FeaturesResponse["features"]["auth"]["providers"][string];

export type AuthProviderResolver = Readonly<{
    id: AuthProviderId;
    resolveFeatures: (params: { env: NodeJS.ProcessEnv; policy: AuthPolicy }) => AuthProviderFeatures;
    requiresOAuth: boolean;
    isConfigured: (env: NodeJS.ProcessEnv) => boolean;
}>;

