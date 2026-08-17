import { type Fastify } from "../../types";
import { registerVoiceTokenRoute } from "./registerVoiceTokenRoute";
import { registerVoiceLeaseMintRoute } from "./registerVoiceLeaseMintRoute";
import { registerVoiceSessionCompleteRoute } from "./registerVoiceSessionCompleteRoute";
import { registerVoiceSessionStartRoute } from "./registerVoiceSessionStartRoute";
import { registerVoiceSessionReleaseRoute } from "./registerVoiceSessionReleaseRoute";
import { resolveVoiceMintRouteRateLimit } from "./voiceMintRateLimit";

export function voiceRoutes(app: Fastify): void {
    // `@fastify/rate-limit` decorates the app during plugin boot. Register the
    // routes after that decoration exists, then create exactly one handler for
    // both aliases so they share the plugin's one child store.
    app.after((error) => {
        if (error) throw error;

        const mintRateLimitConfig = resolveVoiceMintRouteRateLimit(process.env);
        const mintRateLimit = mintRateLimitConfig === false ? undefined : app.rateLimit(mintRateLimitConfig);
        registerVoiceTokenRoute(app, mintRateLimit);
        registerVoiceLeaseMintRoute(app, mintRateLimit);
        registerVoiceSessionStartRoute(app);
        registerVoiceSessionCompleteRoute(app);
        registerVoiceSessionReleaseRoute(app);
    });
}
