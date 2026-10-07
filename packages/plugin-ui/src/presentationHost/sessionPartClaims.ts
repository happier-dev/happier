import { useCallback, useId, useLayoutEffect, useSyncExternalStore } from 'react';

export type SessionPartKind = 'transcript' | 'composer';

/** One live slot of each kind within a Session controller's arrangement. */
export type SessionPartClaims = Readonly<{
  subscribe(listener: () => void): () => void;
  owner(part: SessionPartKind): string | null;
  claim(parts: readonly SessionPartKind[], id: string): void;
  release(parts: readonly SessionPartKind[], id: string): void;
}>;

export function createSessionPartClaims(): SessionPartClaims {
  const owners: Record<SessionPartKind, string | null> = { transcript: null, composer: null };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    owner: (part) => owners[part],
    claim(parts, id) {
      // A standard arrangement must not take half the composition beside a loose part.
      if (parts.some((part) => owners[part] !== null && owners[part] !== id)) return;
      let changed = false;
      for (const part of parts) {
        if (owners[part] === id) continue;
        owners[part] = id;
        changed = true;
      }
      if (changed) emit();
    },
    release(parts, id) {
      let changed = false;
      for (const part of parts) {
        if (owners[part] !== id) continue;
        owners[part] = null;
        changed = true;
      }
      if (changed) emit();
    },
  };
}

const NO_SUBSCRIPTION = () => () => undefined;

/** An unbound or duplicate slot never reaches its renderer. Keep `parts` stable for its lifetime. */
export function useSessionPartClaim(claims: SessionPartClaims | null, parts: readonly SessionPartKind[]): boolean {
  const id = useId();
  const readOwners = useCallback(
    () => parts.map((part) => claims?.owner(part) ?? '').join('|'),
    [claims, parts],
  );
  const owners = useSyncExternalStore(claims?.subscribe ?? NO_SUBSCRIPTION, readOwners, readOwners);
  useLayoutEffect(() => {
    claims?.claim(parts, id);
  }, [claims, id, owners, parts]);
  useLayoutEffect(() => () => claims?.release(parts, id), [claims, id, parts]);
  return claims !== null && parts.every((part) => claims.owner(part) === id);
}
