import { evaluateFeatureBuildPolicy } from "@happier-dev/protocol";

import { readE2eeFeatureEnv, readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveServerFeatureBuildPolicy } from "@/app/features/catalog/serverFeatureBuildPolicy";

export type KeylessAccountsAvailability =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: "keyless-disabled" | "e2ee-required" }>;

export function resolveKeylessAccountsAvailability(env: NodeJS.ProcessEnv): KeylessAccountsAvailability {
    const buildPolicy = resolveServerFeatureBuildPolicy(env);
    const e2eeEnv = readE2eeFeatureEnv(env);
    if (!e2eeEnv.keylessAccountsEnabled || evaluateFeatureBuildPolicy(buildPolicy, "e2ee.keylessAccounts") === "deny") {
        return { ok: false, reason: "keyless-disabled" };
    }
    const encryptionEnv = readEncryptionFeatureEnv(env);
    if (encryptionEnv.storagePolicy === "required_e2ee" || evaluateFeatureBuildPolicy(buildPolicy, "encryption.plaintextStorage") === "deny") {
        return { ok: false, reason: "e2ee-required" };
    }
    return { ok: true };
}

export function resolveKeylessAccountsEnabled(env: NodeJS.ProcessEnv): boolean {
    return resolveKeylessAccountsAvailability(env).ok;
}
