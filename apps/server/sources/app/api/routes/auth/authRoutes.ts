import { type Fastify } from "../../types";
import { registerKeyChallengeAuthRoute } from "./registerKeyChallengeAuthRoute";
import { registerTerminalAuthRequestRoutes } from "./registerTerminalAuthRequestRoutes";
import { registerAccountAuthRoutes } from "./registerAccountAuthRoutes";
import { resolveTerminalAuthRequestPolicyFromEnv } from "./terminalAuthRequestPolicy";

export function authRoutes(app: Fastify): void {
    const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv(process.env);
    const isTerminalAuthExpired = (createdAt: Date): boolean => {
        const ageMs = Date.now() - createdAt.getTime();
        return ageMs > terminalAuthPolicy.ttlMs;
    };

    registerKeyChallengeAuthRoute(app);
    registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy, isTerminalAuthExpired });
    registerAccountAuthRoutes(app);
}
