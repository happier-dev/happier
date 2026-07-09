import { createHash } from 'node:crypto';

import type { ManagedServerSnapshotV1 } from '@happier-dev/plugin-sdk';

/**
 * Stable, redactable identity for a managed server process supervised by the generic plugin host
 * ({@link createPluginManagedServerService}). Shared by all managed-server providers (OpenCode
 * `serve`, Codex app-server, …).
 *
 * The `generationKey` changes whenever the underlying server process is REPLACED (a new
 * `supervise()` handle / new spawned process). It is the runtime-facing "which process am I talking
 * to?" identity and is DISTINCT from the launch fingerprint, which determines server REUSE/selection
 * (see the per-provider `resolveStateFingerprintInput` + the host `resolveManagedServerStatePath`). A
 * launch fingerprint can be reused across many process generations; a generation key tracks the
 * specific process generation.
 *
 * `../dev`'s generic managed server does NOT persist a state file and does NOT support in-place
 * restart ({@link createPluginManagedServerService} throws `PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED}).
 * A "server generation" therefore means a NEW supervise handle / new spawned process, surfaced via
 * the {@link ManagedServerSnapshotV1}. This helper derives the generation identity from the snapshot
 * (the available identity source), not from a persisted owner token.
 *
 * Consumers: generation-aware turn recovery (Plan Lane E) compares `generationKey` to detect mid-turn
 * server replacement.
 */
export type ManagedServerIdentity = Readonly<{
    id: string;
    baseUrl: string;
    pid: number;
    startedAtMs: number;
    port?: number;
    generationKey: string;
}>;

export type ManagedServerIdentityChangeReason =
    | 'initial'
    | 'state_refresh'
    | 'health_recheck'
    | 'explicit_dispose';

export type ManagedServerIdentityChange = Readonly<{
    previous: ManagedServerIdentity | null;
    current: ManagedServerIdentity | null;
    reason: ManagedServerIdentityChangeReason;
}>;

/**
 * Compute the stable generation key from the identity-bearing snapshot fields. `id`, `pid`,
 * `startedAtMs`, and `baseUrl` together uniquely identify a process generation; liveness fields
 * (`lastHealthyAt`) are intentionally excluded so a healthy-pulse does not look like a new
 * generation. No secret/credential values are included; the result is a sha256 hex digest.
 */
function computeGenerationKey(identity: Omit<ManagedServerIdentity, 'generationKey'>): string {
    const parts = [
        `id=${identity.id}`,
        `pid=${identity.pid}`,
        `startedAtMs=${identity.startedAtMs}`,
        identity.baseUrl ? `baseUrl=${identity.baseUrl}` : '',
        identity.port !== undefined ? `port=${identity.port}` : '',
    ].filter((part) => part.length > 0);
    return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function resolveManagedServerIdentity(snapshot: ManagedServerSnapshotV1): ManagedServerIdentity {
    const partial: Omit<ManagedServerIdentity, 'generationKey'> = {
        id: snapshot.id,
        baseUrl: typeof snapshot.baseUrl === 'string' ? snapshot.baseUrl : '',
        pid: Number.isFinite(snapshot.pid) && (snapshot.pid ?? -1) > 0 ? (snapshot.pid as number) : -1,
        startedAtMs: Number.isFinite(snapshot.startedAt) ? (snapshot.startedAt as number) : 0,
        ...(Number.isFinite(snapshot.port) && (snapshot.port ?? -1) > 0 ? { port: snapshot.port as number } : {}),
    };
    return {
        ...partial,
        generationKey: computeGenerationKey(partial),
    };
}

export function isSameManagedServerGeneration(
    a: ManagedServerIdentity | null,
    b: ManagedServerIdentity | null,
): boolean {
    if (!a || !b) return a === b;
    return a.generationKey === b.generationKey;
}

/**
 * Sanitized, log-safe summary. The generation key (a hash) is truncated for compact logs; no
 * credential env values are ever included.
 */
export function describeManagedServerIdentityForLog(
    identity: ManagedServerIdentity | null,
): Record<string, unknown> {
    if (!identity) return { present: false };
    return {
        id: identity.id,
        generationKey: identity.generationKey.slice(0, 12),
        baseUrl: identity.baseUrl,
        pid: identity.pid,
        startedAtMs: identity.startedAtMs,
        ...(identity.port !== undefined ? { port: identity.port } : {}),
    };
}
