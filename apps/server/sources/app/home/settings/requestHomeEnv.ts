import { readServerConfig, type ServerConfigEnv, type ServerConfigReadValue } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type { ServerConfigEntry } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import { buildHomeConfigEnvFromRecord, readHomeConfigSnapshot, type HomeConfigSnapshot } from "./homeSettings";
import { readHomeConfigFlag, composeHomeConfigEnv, readHomeConfigEnvOrigin } from './homeConfigOverlay';

/**
 * The request-scoped configuration overlay (plan `2026-09-26-home-owner-console` §3.1
 * "Request/job-scoped configuration"; the `request.homeEnv` of §6 U11).
 *
 * A route that reads configuration reads it from here instead of `process.env`: the process
 * environment (deployment env plus the restart values this process started with) with the Home's
 * `apply: 'live'` settings filled in for every key the deployment leaves unset. The Home settings
 * row is read at most once per request, lazily, and only by requests that ask; nothing is cached
 * across requests, so every replica sees a change on its next request. The one exception is the
 * per-request authentication diagnostics flag (`authDiagnosticsFlag.ts`).
 *
 * A plain helper rather than a Fastify decorator, so the route modules registered by tests on bare
 * Fastify instances reach the same owner without extra composition.
 */
type RequestHomeConfig = {
    snapshot: Promise<HomeConfigSnapshot>;
    overlay?: Promise<ServerConfigEnv>;
};

const captures = new WeakMap<object, RequestHomeConfig>();

function captureRequestHomeConfig(request: object): RequestHomeConfig {
    const existing = captures.get(request);
    if (existing) return existing;
    // Deployment env is process-start fixed; retain its identity for startup deployment-lock provenance.
    const capture: RequestHomeConfig = { snapshot: readHomeConfigSnapshot(process.env) };
    captures.set(request, capture);
    // A failed capture refuses this read but does not poison a later retry.
    capture.snapshot.catch(() => {
        if (captures.get(request) === capture) captures.delete(request);
    });
    return capture;
}

/** Read a plain boolean flag through the same precedence/alias owner, without opening secrets. */
export async function readRequestHomeFlag<E extends ServerConfigEntry & { type: 'boolean'; sensitivity: 'plain' }>(
    request: object,
    entry: E,
): Promise<ServerConfigReadValue<E>> {
    const capture = captureRequestHomeConfig(request);
    if (capture.overlay) return readServerConfig(await capture.overlay, entry);
    return readHomeConfigSnapshotFlag(await capture.snapshot, entry);
}

/** One plain boolean from a captured snapshot, through the same precedence/alias owner, without opening secrets. */
export function readHomeConfigSnapshotFlag<E extends ServerConfigEntry & { type: 'boolean'; sensitivity: 'plain' }>(
    snapshot: HomeConfigSnapshot,
    entry: E,
): ServerConfigReadValue<E> {
    const values = Object.prototype.hasOwnProperty.call(snapshot.policyValues, entry.key)
        ? snapshot.policyValues : snapshot.record.values;
    return readHomeConfigFlag(snapshot.base, { [entry.key]: values[entry.key] }, entry);
}

export function readRequestHomeEnv(
    request: object,
    options?: Readonly<{ inferred: Readonly<Record<string, string>> }>,
): Promise<ServerConfigEnv> {
    const capture = captureRequestHomeConfig(request);
    let overlay = capture.overlay;
    if (!overlay) {
        overlay = capture.snapshot.then(snapshot => buildHomeConfigEnvFromRecord(
            snapshot.base, snapshot.record, undefined, snapshot.policyValues,
        ));
    }
    if (options) {
        // Reach can finish inference after authentication first read this snapshot. Recompose
        // through the same precedence owner, retaining the captured rows rather than reading again.
        overlay = overlay.then((env) => {
            const origin = readHomeConfigEnvOrigin(env);
            if (!origin) throw new Error('Request Home environment has no configuration origin');
            return composeHomeConfigEnv({ ...origin, inferred: options.inferred }, { snapshot: true });
        });
    }
    capture.overlay = overlay;
    overlay.catch(() => {
        if (captures.get(request) === capture && capture.overlay === overlay) captures.delete(request);
    });
    return overlay;
}
