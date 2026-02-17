import type { FeaturesResponse } from "./types";
import { resolveElevenLabsAgentId } from "@/voice/elevenLabsEnv";
import { readVoiceFeatureEnv } from "./catalog/readFeatureEnv";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

export function resolveVoiceFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "voice"> {
    const featureConfig = readVoiceFeatureEnv(env);
    const voiceEnabledByEnv = featureConfig.enabled;
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("voice", env);
    const elevenLabsApiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
    const elevenLabsAgentId = resolveElevenLabsAgentId(env);
    const elevenLabsConfigured = Boolean(elevenLabsApiKey) && Boolean(elevenLabsAgentId);
    const requireSubscription = featureConfig.requireSubscription;
    const revenueCatConfigured = !requireSubscription || Boolean(env.REVENUECAT_SECRET_KEY?.trim());
    const configured = elevenLabsConfigured && revenueCatConfigured;
    const enabled = buildEnabled && voiceEnabledByEnv && configured;

    return {
        voice: {
            enabled,
            configured,
            provider: configured ? "elevenlabs" : null,
        },
    };
}
