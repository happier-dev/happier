import { parseBooleanEnv } from "@/config/env";
import type { FeaturesResponse } from "./types";
import { resolveElevenLabsAgentId } from "@/voice/elevenLabsEnv";

export function resolveVoiceFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "voice"> {
    const isProduction = env.NODE_ENV === "production";
    const voiceEnabledByEnv = parseBooleanEnv(env.VOICE_ENABLED, true);
    const elevenLabsApiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
    const elevenLabsAgentId = resolveElevenLabsAgentId(env);
    const elevenLabsConfigured = Boolean(elevenLabsApiKey) && Boolean(elevenLabsAgentId);
    const requireSubscription = parseBooleanEnv(env.VOICE_REQUIRE_SUBSCRIPTION, isProduction);
    const revenueCatConfigured = !requireSubscription || Boolean(env.REVENUECAT_SECRET_KEY?.trim());
    const configured = elevenLabsConfigured && revenueCatConfigured;
    const enabled = voiceEnabledByEnv && configured;

    return {
        voice: {
            enabled,
            configured,
            provider: configured ? "elevenlabs" : null,
        },
    };
}
