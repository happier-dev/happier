import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { applyEnvValues, snapshotEnv, type EnvValues } from "./env";

export async function applyLightAuthTestEnv(overrides: EnvValues = {}): Promise<NodeJS.ProcessEnv> {
    applyEnvValues(overrides);
    applyLightDefaultEnv(process.env);
    await ensureHandyMasterSecret(process.env);
    return snapshotEnv();
}
