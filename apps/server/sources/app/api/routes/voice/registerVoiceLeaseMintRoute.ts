import { type Fastify } from "../../types";
import { registerVoiceMintRoute } from "./registerVoiceMintRoute";
import type { VoiceMintRateLimitHandler } from "./voiceMintRateLimit";

export function registerVoiceLeaseMintRoute(app: Fastify, mintRateLimit: VoiceMintRateLimitHandler | undefined): void {
    registerVoiceMintRoute(app, "/v1/voice/lease/mint", mintRateLimit);
}
