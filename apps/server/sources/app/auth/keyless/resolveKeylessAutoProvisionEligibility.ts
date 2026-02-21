import { resolveEffectiveDefaultAccountEncryptionMode } from "@happier-dev/protocol";

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";

export type KeylessAutoProvisionEligibility =
    | Readonly<{ ok: true; encryptionMode: "plain" }>
    | Readonly<{ ok: false; error: "e2ee-required" }>;

export function resolveKeylessAutoProvisionEligibility(env: NodeJS.ProcessEnv): KeylessAutoProvisionEligibility {
    const encryptionEnv = readEncryptionFeatureEnv(env);
    const effectiveDefaultEncryptionMode = resolveEffectiveDefaultAccountEncryptionMode(
        encryptionEnv.storagePolicy,
        encryptionEnv.defaultAccountMode,
    );
    const canProvisionKeyless = resolveKeylessAccountsEnabled(env) && effectiveDefaultEncryptionMode === "plain";
    if (!canProvisionKeyless) return { ok: false, error: "e2ee-required" };
    return { ok: true, encryptionMode: "plain" };
}

