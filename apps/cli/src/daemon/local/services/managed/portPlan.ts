import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

import {
    createLocalServicePortAllocator,
    type LocalServicePortAllocator,
    type LocalServicePortPolicy,
    type LocalServicePortReservationDiagnostic,
} from './ports';

/**
 * Per-group peer port plan (refinements 3/4 of FP-LSV-MANAGED-1).
 *
 * The reference `ensureWorkspaceServicePortPlan` resolves every peer's port before any peer
 * spawns so a service can be handed `<NAME>_PORT`/`<NAME>_URL` for its peers up front;
 * that is what makes `portPolicy.kind:'inherited'` real. Ours is scoped to a single
 * owner+session group — NEVER workspace-global — keyed by `(ownerKey, sessionId)`.
 *
 * This module is a thin, pure-ish wrapper around the existing `createLocalServicePortAllocator`
 * (`ports.ts`) plus the env-name collision guard; it does not widen `ports.ts` (whose
 * `LocalServicePortPolicy` is only `fixed`/`allocated` — `inherited` is resolved here by
 * reading a peer's planned port from the same group plan).
 */

export type LocalServiceEnvNameCollisionError = Readonly<{
    kind: 'env_name_collision';
    envName: string;
    serviceIds: readonly [string, string];
}>;

export type LocalServicePortPlanEntry = Readonly<{
    serviceId: string;
    /** Normalized peer env-var prefix, e.g. `web-1` -> `WEB_1`. */
    envName: string;
    port: number;
    url: string;
    diagnostics: readonly LocalServicePortReservationDiagnostic[];
}>;

export type LocalServicePortPlanResult =
    | Readonly<{ ok: true; entries: readonly LocalServicePortPlanEntry[] }>
    | Readonly<{ ok: false; reason: 'env_name_collision'; collision: LocalServiceEnvNameCollisionError }>
    | Readonly<{ ok: false; reason: 'port_unavailable' | 'no_available_ports'; serviceId: string; diagnostics: readonly LocalServicePortReservationDiagnostic[] }>;

/** Upcase + `[^A-Z0-9]` -> `_`, matching the reference env-name normalizer shape. */
export function normalizeServiceEnvName(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function loopbackUrl(host: string, port: number): string {
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${formattedHost}:${port}`;
}

/**
 * Map the SDK `assignAndInject` port policy onto the allocator's `fixed`/`allocated` policy.
 * `inherited` is NOT a reservation — it reads a peer's already-planned port, so it is handled
 * by the caller (it returns null here to signal "resolve from the plan").
 */
function toAllocatorPolicy(
    declaration: LocalServiceDeclarationV1,
): LocalServicePortPolicy | null {
    if (declaration.launchMode.kind !== 'assignAndInject') return null;
    const policy = declaration.launchMode.portPolicy;
    if (policy.kind === 'fixed') {
        return { kind: 'fixed', port: policy.port, onCollision: policy.onCollision ?? 'fail' };
    }
    if (policy.kind === 'allocated') {
        const allocated: LocalServicePortPolicy = policy.preferredPort !== undefined
            ? { kind: 'allocated', preferredPort: policy.preferredPort, onCollision: policy.onCollision ?? 'fallback' }
            : { kind: 'allocated', onCollision: policy.onCollision ?? 'fallback' };
        return allocated;
    }
    return null;
}

export type LocalServicePortPlanInput = Readonly<{
    /** Every assign-and-inject declaration in the owner+session group, including the one being started. */
    declarations: readonly Readonly<{ serviceKey: string; declaration: LocalServiceDeclarationV1 }>[];
    host: string;
    allocator: LocalServicePortAllocator;
}>;

/**
 * Build the group port plan: resolve every peer's port (honor fixed/configured verbatim,
 * else allocate once), enforce the env-name collision guard, then resolve `inherited`
 * policies against the plan. Returns one entry per assign-and-inject declaration.
 */
export function buildLocalServicePortPlan(input: LocalServicePortPlanInput): LocalServicePortPlanResult {
    // Env-name collision guard (refinement 4): two declared ids must not collapse to the
    // same normalized peer env key, else one peer's URL would silently clobber another's.
    const byEnvName = new Map<string, string>();
    for (const { declaration } of input.declarations) {
        if (declaration.launchMode.kind !== 'assignAndInject') continue;
        const envName = normalizeServiceEnvName(declaration.id);
        if (envName.length === 0) continue;
        const previous = byEnvName.get(envName);
        if (previous !== undefined && previous !== declaration.id) {
            return {
                ok: false,
                reason: 'env_name_collision',
                collision: { kind: 'env_name_collision', envName, serviceIds: [previous, declaration.id] },
            };
        }
        byEnvName.set(envName, declaration.id);
    }

    // First pass: reserve fixed/allocated ports for every peer so inherited can read them.
    const reserved = new Map<string, { port: number; diagnostics: readonly LocalServicePortReservationDiagnostic[] }>();
    for (const { serviceKey, declaration } of input.declarations) {
        const policy = toAllocatorPolicy(declaration);
        if (!policy) continue; // inherited (or non-assign) — resolved in pass two.
        const reservation = input.allocator.reserve({ serviceId: serviceKey, policy });
        if (!reservation.ok) {
            return { ok: false, reason: reservation.reason, serviceId: declaration.id, diagnostics: reservation.diagnostics };
        }
        reserved.set(declaration.id, { port: reservation.port, diagnostics: reservation.diagnostics });
    }

    // Second pass: resolve inherited policies against the plan + project entries.
    const entries: LocalServicePortPlanEntry[] = [];
    for (const { declaration } of input.declarations) {
        if (declaration.launchMode.kind !== 'assignAndInject') continue;
        const policy = declaration.launchMode.portPolicy;
        if (policy.kind === 'inherited') {
            // The envName points at a peer's planned port (e.g. `WEB`). Resolve it.
            const peerId = [...reserved.keys()].find((id) => normalizeServiceEnvName(id) === normalizeServiceEnvName(policy.envName));
            const peer = peerId ? reserved.get(peerId) : undefined;
            if (!peer) {
                return { ok: false, reason: 'port_unavailable', serviceId: declaration.id, diagnostics: [{ code: 'inherited_peer_unresolved', severity: 'error' }] };
            }
            entries.push({
                serviceId: declaration.id,
                envName: normalizeServiceEnvName(declaration.id),
                port: peer.port,
                url: loopbackUrl(input.host, peer.port),
                diagnostics: [],
            });
            continue;
        }
        const reservation = reserved.get(declaration.id);
        if (!reservation) {
            return { ok: false, reason: 'port_unavailable', serviceId: declaration.id, diagnostics: [{ code: 'port_unavailable', severity: 'error' }] };
        }
        entries.push({
            serviceId: declaration.id,
            envName: normalizeServiceEnvName(declaration.id),
            port: reservation.port,
            url: loopbackUrl(input.host, reservation.port),
            diagnostics: reservation.diagnostics,
        });
    }
    return { ok: true, entries };
}

export {
    createLocalServicePortAllocator,
    type LocalServicePortAllocator,
};
