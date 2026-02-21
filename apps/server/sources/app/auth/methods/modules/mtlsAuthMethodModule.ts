import type { AuthMethodModule } from "@/app/auth/methods/types";

import { registerMtlsAuthRoutes } from "@/app/auth/providers/mtls/registerMtlsAuthRoutes";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAutoProvisionEligibility } from "@/app/auth/keyless/resolveKeylessAutoProvisionEligibility";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";

function isMtlsGateEnabled(env: NodeJS.ProcessEnv): boolean {
    const mtlsEnv = readAuthMtlsFeatureEnv(env);
    if (!mtlsEnv.enabled) return false;
    if (mtlsEnv.mode !== "forwarded") return false;
    if (!mtlsEnv.trustForwardedHeaders) return false;
    return true;
}

export const mtlsAuthMethodModule: AuthMethodModule = Object.freeze({
    id: "mtls",
    resolveAuthMethod: ({ env }) => {
        const mtlsEnv = readAuthMtlsFeatureEnv(env);
        const gateEnabled = isMtlsGateEnabled(env);
        const keylessEnabled = resolveKeylessAccountsEnabled(env);
        const provisionEligible = resolveKeylessAutoProvisionEligibility(env).ok;
        return {
            id: "mtls",
            actions: [
                { id: "login", enabled: gateEnabled && keylessEnabled, mode: "keyless" },
                { id: "provision", enabled: gateEnabled && mtlsEnv.autoProvision && provisionEligible, mode: "keyless" },
            ],
            ui: { displayName: "Certificate", iconHint: null },
        };
    },
    isViable: (env) => isMtlsGateEnabled(env),
    registerRoutes: (app) => registerMtlsAuthRoutes(app),
});
