import { type Fastify } from "../../types";
import { registerVoiceTokenRoute } from "./registerVoiceTokenRoute";
import { registerVoiceSessionCompleteRoute } from "./registerVoiceSessionCompleteRoute";

export function voiceRoutes(app: Fastify): void {
    registerVoiceTokenRoute(app);
    registerVoiceSessionCompleteRoute(app);
}
