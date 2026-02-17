import type { FeaturesPayloadDelta } from "./types";
import { resolveElevenLabsAgentId } from "@/voice/elevenLabsEnv";
import { readVoiceFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveVoiceFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readVoiceFeatureEnv(env);
    const voiceEnabledByEnv = featureConfig.enabled;
    const elevenLabsApiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
    const elevenLabsAgentId = resolveElevenLabsAgentId(env);
    const elevenLabsConfigured = Boolean(elevenLabsApiKey) && Boolean(elevenLabsAgentId);
    const requireSubscription = featureConfig.requireSubscription;
    const revenueCatConfigured = !requireSubscription || Boolean(env.REVENUECAT_SECRET_KEY?.trim());
    const configured = elevenLabsConfigured && revenueCatConfigured;
    const enabled = voiceEnabledByEnv;
    const happierVoiceEnabled = voiceEnabledByEnv && configured;

    return {
        features: {
            voice: { enabled, happierVoice: { enabled: happierVoiceEnabled } },
        },
        capabilities: {
            voice: {
                configured,
                provider: configured ? "elevenlabs" : null,
                requested: voiceEnabledByEnv,
            },
        },
    };
}
