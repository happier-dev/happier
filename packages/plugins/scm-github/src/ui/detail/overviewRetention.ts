import { useEffect, useState } from 'react';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { settleGithubOverviewReadV1, type GithubOverviewReadStateV1 } from './overviewState.js';
import type { GithubReadStateV1 } from './panelState.js';

const LOADING = Object.freeze({ kind: 'loading' as const });
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const,
  failure: Object.freeze({ class: 'unknown' as const, code: 'github-overview-scope-unavailable' }) });

type SettledOverview = Readonly<{
  head: string | undefined;
  revision: string;
  state: GithubOverviewReadStateV1;
}>;

type RetainedOverview = {
  getSnapshot(): SettledOverview | null;
  subscribe(listener: () => void): () => void;
  settle(next: SettledOverview): SettledOverview;
};

/**
 * Closing an entry retires its reader, not the settled result for that exact
 * authority. The existing host scope owns retention across those mounts. This
 * value publishes settled answers to mounted exact-target readers. It holds no
 * transport, pending work, or automatic demand.
 */
export function useGithubOverviewRetention(key: string, initial?: SettledOverview): GithubReadStateV1<RetainedOverview> {
  const scope = usePluginUiEphemeralSharedScope();
  const [held, setHeld] = useState<Readonly<{ scope: typeof scope; key: string; initial: typeof initial; state: GithubReadStateV1<RetainedOverview> }> | null>(null);
  useEffect(() => {
    const create = () => {
      let settled: SettledOverview | null = null;
      const listeners = new Set<() => void>();
      const value: RetainedOverview = {
        getSnapshot: () => settled,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        settle(next) {
          // The shared exact-target value is the baseline, including choices
          // acquired by a sibling before this reader mounted or became active.
          const previous = settled?.state ?? next.state;
          const state = next.state.failure !== null || next.state.value === null
            ? { ...previous, refreshing: false, failure: next.state.failure }
            : settleGithubOverviewReadV1(previous, next.state.value);
          settled = { ...next, state };
          for (const listener of listeners) listener();
          return settled;
        },
      };
      return { value, retainWhenIdle: true as const, dispose() { settled = null; listeners.clear(); } };
    };
    // Only settled presentation data is retained. The read Action owns its
    // execution authority; an Account renderer need not have a Machine origin.
    // A retired shared scope still supplies no artifact-local fallback.
    const lease = scope?.acquire(`github.overview.v1:${key}`, create) ?? null;
    const local = scope === null ? create() : null;
    const value = lease?.value ?? local?.value;
    // Fresh opening facts replace older retained presentation. A tab mounting
    // with its original launch data must preserve a later explicit refresh.
    if (initial !== undefined && value !== undefined) {
      const current = value.getSnapshot();
      const openingAtMs = initial.state.value?.observedAtMs;
      const retainedAtMs = current?.state.value?.observedAtMs;
      if (current === null || (openingAtMs !== undefined && (retainedAtMs === undefined || openingAtMs > retainedAtMs))) {
        value.settle(initial);
      }
    }
    setHeld({ scope, key, initial, state: value === undefined ? UNAVAILABLE : { kind: 'ready', value } });
    return () => { lease?.release(); local?.dispose(); };
  }, [initial, key, scope]);
  return held?.scope === scope && held.key === key && held.initial === initial ? held.state : LOADING;
}
