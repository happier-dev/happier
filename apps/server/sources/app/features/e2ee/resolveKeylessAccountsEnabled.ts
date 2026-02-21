import { readE2eeFeatureEnv, readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

export type KeylessAccountsAvailability =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: "keyless-disabled" | "e2ee-required" }>;

export function resolveKeylessAccountsAvailability(env: NodeJS.ProcessEnv): KeylessAccountsAvailability {
    const e2eeEnv = readE2eeFeatureEnv(env);
    if (!e2eeEnv.keylessAccountsEnabled) {
        return { ok: false, reason: "keyless-disabled" };
    }
    const encryptionEnv = readEncryptionFeatureEnv(env);
    if (encryptionEnv.storagePolicy === "required_e2ee") {
        return { ok: false, reason: "e2ee-required" };
    }
    return { ok: true };
}

export function resolveKeylessAccountsEnabled(env: NodeJS.ProcessEnv): boolean {
    return resolveKeylessAccountsAvailability(env).ok;
}
