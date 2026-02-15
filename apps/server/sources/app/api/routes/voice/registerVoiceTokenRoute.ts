import { type Fastify } from "../../types";
import { registerVoiceMintRoute } from "./registerVoiceMintRoute";

export function registerVoiceTokenRoute(app: Fastify): void {
    registerVoiceMintRoute(app, "/v1/voice/token");
}

