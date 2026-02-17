import { describe, expect, it } from "vitest";

import { resolveServerFeaturePayload } from "./resolveServerFeaturePayload";
import { resolveServerFeatureBuildPolicy } from "./serverFeatureBuildPolicy";
import type { ServerFeatureResolver } from "./serverFeatureRegistry";
import type { FeaturesPayloadDelta } from "@/app/features/types";
import { evaluateFeatureBuildPolicy } from "@happier-dev/protocol";

function fromPartial(partial: FeaturesPayloadDelta): ServerFeatureResolver {
    return () => partial;
}

describe("resolveServerFeaturePayload", () => {
    it("forces server feature gates disabled when build policy denies a represented feature", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_DENY: "connectedServices",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices")).toBe("deny");

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: true, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(false);
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
    });

    it("forces server feature gates disabled when build policy allowlist omits a represented feature", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_ALLOW: "connectedServices",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices")).toBe("allow");
        expect(evaluateFeatureBuildPolicy(buildPolicy, "connectedServices.quotas")).toBe("deny");

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: true, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(true);
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
    });

    it("forces represented features disabled when a represented dependency is disabled", () => {
        const payload = resolveServerFeaturePayload(
            {} as NodeJS.ProcessEnv,
            [
                fromPartial({
                    features: {
                        connectedServices: { enabled: false, quotas: { enabled: true } },
                    },
                }),
            ],
        );

        expect(payload.features.connectedServices.enabled).toBe(false);
        expect(payload.features.connectedServices.quotas.enabled).toBe(false);
    });

    it("annotates capabilities when build policy denies Happier Voice", () => {
        const env = {
            HAPPIER_BUILD_FEATURES_DENY: "voice.happierVoice",
        } as NodeJS.ProcessEnv;

        const buildPolicy = resolveServerFeatureBuildPolicy(env);
        expect(evaluateFeatureBuildPolicy(buildPolicy, "voice.happierVoice")).toBe("deny");

        const payload = resolveServerFeaturePayload(
            env,
            [
                fromPartial({
                    features: {
                        voice: { enabled: true, happierVoice: { enabled: true } },
                    },
                    capabilities: {
                        voice: {
                            configured: false,
                            provider: null,
                        },
                    },
                }),
            ],
        );

        expect(payload.features.voice.enabled).toBe(true);
        expect(payload.features.voice.happierVoice.enabled).toBe(false);
        expect(payload.capabilities.voice.disabledByBuildPolicy).toBe(true);
    });
});
