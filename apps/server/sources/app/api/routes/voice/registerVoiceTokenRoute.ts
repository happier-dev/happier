import { type Fastify } from "../../types";
import { registerVoiceMintRoute } from "./registerVoiceMintRoute";
import type { VoiceMintRateLimitHandler } from "./voiceMintRateLimit";

export function registerVoiceTokenRoute(app: Fastify, mintRateLimit: VoiceMintRateLimitHandler | undefined): void {
    registerVoiceMintRoute(app, "/v1/voice/token", mintRateLimit);
}
