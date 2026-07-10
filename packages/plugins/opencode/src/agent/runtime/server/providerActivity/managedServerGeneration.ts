import { createHash } from 'node:crypto';

import type { ManagedServerSnapshotV1 } from '@happier-dev/plugin-sdk';

/**
 * Stable, redactable identity for the managed `opencode serve` process the runtime is talking to.
 *
 * The `generationKey` changes whenever the underlying server process is REPLACED (a new
 * `supervise()` handle / new spawned process surfaced via the {@link ManagedServerSnapshotV1}).
 * `../dev`'s generic managed server does NOT support in-place restart and the plugin cannot reach the
 * host-side identity helper (cross-package boundary), so the generation identity is derived here from
 * the snapshot fields the plugin already receives — the available identity source, shared with the
 * host helper's computation (`apps/cli/.../managedServerIdentity.ts`). It is DISTINCT from the launch
 * fingerprint that drives server REUSE; a launch fingerprint can be reused across many generations.
 *
 * Consumer: the generation-aware turn-interruption supervisor (Plan Lane E) compares `generationKey`
 * to detect mid-turn server replacement and close the orphaned-work wedge.
 */
export type OpenCodeManagedServerGenerationIdentity = Readonly<{
  id: string;
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  port?: number;
  generationKey: string;
}>;

/**
 * Compute the stable generation key from the identity-bearing snapshot fields. `id`, `pid`,
 * `startedAtMs`, and `baseUrl` together uniquely identify a process generation; liveness fields
 * (`lastHealthyAt`) are intentionally excluded so a healthy-pulse does not look like a new
 * generation. No secret/credential values are included; the result is a sha256 hex digest.
 */
function computeGenerationKey(
  identity: Omit<OpenCodeManagedServerGenerationIdentity, 'generationKey'>,
): string {
  const parts = [
    `id=${identity.id}`,
    `pid=${identity.pid}`,
    `startedAtMs=${identity.startedAtMs}`,
    identity.baseUrl ? `baseUrl=${identity.baseUrl}` : '',
    identity.port !== undefined ? `port=${identity.port}` : '',
  ].filter((part) => part.length > 0);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function resolveOpenCodeManagedServerGenerationIdentity(
  snapshot: ManagedServerSnapshotV1,
): OpenCodeManagedServerGenerationIdentity {
  const partial: Omit<OpenCodeManagedServerGenerationIdentity, 'generationKey'> = {
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

export function isSameOpenCodeManagedServerGeneration(
  a: OpenCodeManagedServerGenerationIdentity | null,
  b: OpenCodeManagedServerGenerationIdentity | null,
): boolean {
  if (!a || !b) return a === b;
  return a.generationKey === b.generationKey;
}

/**
 * Sanitized, log-safe summary. The generation key (a hash) is truncated for compact logs; no
 * credential env values are ever included.
 */
export function describeOpenCodeManagedServerGenerationForLog(
  identity: OpenCodeManagedServerGenerationIdentity | null,
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
