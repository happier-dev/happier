import { useEffect, useRef } from 'react';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { GithubPagedStateV1 } from './panelState.js';

/** The last settled walk for one exact entry, kept where a remounted panel can read it on its first render. */
export type GithubPagedRetentionV1<TRow> = Readonly<{
  initial: GithubPagedStateV1<TRow> | null;
  settle(state: GithubPagedStateV1<TRow>): void;
}>;

type RetainedWalk = { state: GithubPagedStateV1<unknown> | null };
type Scope = ReturnType<typeof usePluginUiEphemeralSharedScope>;
type Held = { key: string; scope: Scope; release: (() => void) | null; value: RetainedWalk | null };

function acquire(scope: Scope, key: string): Held {
  // Only settled presentation data: no transport, pending work or demand. The host scope owns its lifetime.
  const lease = scope?.acquire<RetainedWalk>(`github.files.v1:${key}`, () => ({
    value: { state: null }, retainWhenIdle: true as const, dispose() { /* plain data, collected with the scope */ } })) ?? null;
  return { key, scope, release: lease === null ? null : () => lease.release(), value: lease?.value ?? null };
}

/**
 * Moving the detail between its docked pane and the modal remounts the Files panel. Its walk reads the last
 * settled answer for the same entry from the host's shared scope on its first render, so it shows those rows (no
 * skeleton, no second read) instead of starting cold. `key` names the exact entry and route.
 */
export function useGithubFilesWalkRetention<TRow>(key: string): GithubPagedRetentionV1<TRow> | undefined {
  const scope = usePluginUiEphemeralSharedScope();
  const held = useRef<Held | null>(null);
  // Read synchronously, so the walk's reducer can start from it; the effect owns each lease's release.
  if (held.current === null || held.current.key !== key || held.current.scope !== scope) {
    held.current?.release?.();
    held.current = acquire(scope, key);
  }
  const entry = held.current;
  useEffect(() => {
    // A released lease (an effect re-run) is taken again; the retained value is the same object.
    if (entry.release === null && entry.value !== null) Object.assign(entry, acquire(entry.scope, entry.key));
    return () => { entry.release?.(); entry.release = null; };
  }, [entry]);
  const value = entry.value;
  return value === null ? undefined : {
    initial: value.state as GithubPagedStateV1<TRow> | null,
    settle(state) { value.state = state as GithubPagedStateV1<unknown>; },
  };
}
