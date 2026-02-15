import { type Fastify } from "../../types";
import { registerVoiceMintRoute } from "./registerVoiceMintRoute";

export function registerVoiceLeaseMintRoute(app: Fastify): void {
    registerVoiceMintRoute(app, "/v1/voice/lease/mint");
}

