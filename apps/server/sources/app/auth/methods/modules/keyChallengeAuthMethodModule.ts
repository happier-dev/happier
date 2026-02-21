import type { AuthMethodModule } from "@/app/auth/methods/types";

import { registerKeyChallengeAuthRoute } from "@/app/api/routes/auth/registerKeyChallengeAuthRoute";
import { readAuthFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

export const keyChallengeAuthMethodModule: AuthMethodModule = Object.freeze({
    id: "key_challenge",
    resolveAuthMethod: ({ env, policy }) => {
        const featureEnv = readAuthFeatureEnv(env);
        const loginEnabled = featureEnv.loginKeyChallengeEnabled;
        const provisionEnabled = loginEnabled && policy.anonymousSignupEnabled;
        return {
            id: "key_challenge",
            actions: [
                { id: "login", enabled: loginEnabled, mode: "keyed" },
                { id: "provision", enabled: provisionEnabled, mode: "keyed" },
            ],
            ui: { displayName: "Device key", iconHint: null },
        };
    },
    isViable: (env) => {
        const featureEnv = readAuthFeatureEnv(env);
        return featureEnv.loginKeyChallengeEnabled;
    },
    registerRoutes: (app) => {
        const featureEnv = readAuthFeatureEnv(process.env);
        if (!featureEnv.loginKeyChallengeEnabled) return;
        registerKeyChallengeAuthRoute(app);
    },
});

