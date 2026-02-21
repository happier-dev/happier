import type { Fastify } from "@/app/api/types";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { FeaturesResponse } from "@/app/features/types";

export type AuthMethod = NonNullable<FeaturesResponse["capabilities"]["auth"]["methods"]>[number];

export type AuthMethodModule = Readonly<{
    id: string;
    resolveAuthMethod: (params: { env: NodeJS.ProcessEnv; policy: AuthPolicy }) => AuthMethod;
    /**
     * Whether this method counts as a viable non-key-challenge auth entrypoint for lockout prevention.
     * This should be `true` only when the method is enabled and correctly configured.
     */
    isViable: (env: NodeJS.ProcessEnv) => boolean;
    /**
     * Register any routes required by this auth method. Modules must enforce their own gating/config.
     */
    registerRoutes: (app: Fastify) => void;
}>;

