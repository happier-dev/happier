import { accountDirectorySigningKeyMetadata } from "@/app/accountDirectory/accountDirectorySigner";
import type { FeaturesPayloadDelta } from "./types";

/**
 * Account Directory is an additive capability. The signing key is public
 * metadata; no bearer or Home credential is ever included in this payload.
 */
export function resolveAccountDirectoryFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    try {
        const signing = accountDirectorySigningKeyMetadata(env);
        return {
            capabilities: {
                accountDirectory: {
                    version: 1,
                    homeDirectory: true,
                    homeEnrollment: true,
                    deviceApproval: false,
                    homeLoginAssertion: signing,
                },
            },
        } as unknown as FeaturesPayloadDelta;
    } catch {
        // A missing master secret already prevents auth startup. Keep feature
        // discovery fail-closed while allowing health/configuration routes to
        // remain inspectable.
        return {};
    }
}
