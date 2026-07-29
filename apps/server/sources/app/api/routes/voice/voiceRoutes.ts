import { type Fastify } from "../../types";
import { registerVoiceTokenRoute } from "./registerVoiceTokenRoute";
import { registerVoiceLeaseMintRoute } from "./registerVoiceLeaseMintRoute";
import { registerVoiceSessionCompleteRoute } from "./registerVoiceSessionCompleteRoute";
import { registerVoiceSessionStartRoute } from "./registerVoiceSessionStartRoute";

export function voiceRoutes(app: Fastify): void {
    registerVoiceTokenRoute(app);
    registerVoiceLeaseMintRoute(app);
    registerVoiceSessionStartRoute(app);
    registerVoiceSessionCompleteRoute(app);
}
