import type { ServerConfigEnv } from "@happier-dev/protocol";

import { readHomeConfigEnv } from "./homeSettings";
import { composeHomeConfigEnv, readHomeConfigEnvOrigin } from './homeConfigOverlay';

/**
 * The request-scoped configuration overlay (plan `2026-09-26-home-owner-console` §3.1
 * "Request/job-scoped configuration"; the `request.homeEnv` of §6 U11).
 *
 * A route that reads configuration reads it from here instead of `process.env`: the process
 * environment (deployment env plus the restart values this process started with) with the Home's
 * `apply: 'live'` settings filled in for every key the deployment leaves unset. The Home settings
 * row is read at most once per request, lazily, and only by requests that ask; nothing is cached
 * across requests, so every replica sees a change on its next request.
 *
 * A plain helper rather than a Fastify decorator, so the route modules registered by tests on bare
 * Fastify instances reach the same owner without extra composition.
 */
const overlays = new WeakMap<object, Promise<ServerConfigEnv>>();

export function readRequestHomeEnv(
    request: object,
    options?: Readonly<{ inferred: Readonly<Record<string, string>> }>,
): Promise<ServerConfigEnv> {
    let overlay = overlays.get(request);
    if (!overlay) {
        overlay = readHomeConfigEnv(process.env);
        overlays.set(request, overlay);
        // A failed read is not memoized: the next reader retries instead of replaying the failure.
        overlay.catch(() => overlays.delete(request));
    }
    if (options) {
        // Reach can finish inference after authentication first read this snapshot. Recompose
        // through the same precedence owner, retaining the captured rows rather than reading again.
        overlay = overlay.then((env) => {
            const origin = readHomeConfigEnvOrigin(env);
            if (!origin) throw new Error('Request Home environment has no configuration origin');
            return composeHomeConfigEnv({ ...origin, inferred: options.inferred }, { snapshot: true });
        });
        overlays.set(request, overlay);
        overlay.catch(() => overlays.delete(request));
    }
    return overlay;
}
