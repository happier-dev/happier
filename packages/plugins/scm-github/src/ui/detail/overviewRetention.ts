import { useEffect, useState } from 'react';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { GithubOverviewReadStateV1 } from './overviewState.js';
import type { GithubReadStateV1 } from './panelState.js';

const LOADING = Object.freeze({ kind: 'loading' as const });
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const,
  failure: Object.freeze({ class: 'unknown' as const, code: 'github-overview-scope-unavailable' }) });

type RetainedOverview = {
  settled: Readonly<{
    head: string | undefined;
    revision: number | undefined;
    state: GithubOverviewReadStateV1;
  }> | null;
};

/**
 * Closing an entry retires its reader, not the settled result for that exact
 * authority. The existing host scope owns retention across those mounts. This
 * value holds no transport, pending work, subscriptions, or automatic demand.
 */
export function useGithubOverviewRetention(key: string): GithubReadStateV1<RetainedOverview> {
  const scope = usePluginUiEphemeralSharedScope();
  const [held, setHeld] = useState<Readonly<{ scope: typeof scope; key: string; state: GithubReadStateV1<RetainedOverview> }> | null>(null);
  useEffect(() => {
    const create = () => {
      const value: RetainedOverview = { settled: null };
      return { value, retainWhenIdle: true as const, dispose() { value.settled = null; } };
    };
    // Only settled presentation data is retained. The read Action owns its
    // execution authority; an Account renderer need not have a Machine origin.
    // A retired shared scope still supplies no artifact-local fallback.
    const lease = scope?.acquire(`github.overview.v1:${key}`, create) ?? null;
    const local = scope === null ? create() : null;
    const value = lease?.value ?? local?.value;
    setHeld({ scope, key, state: value === undefined ? UNAVAILABLE : { kind: 'ready', value } });
    return () => { lease?.release(); local?.dispose(); };
  }, [key, scope]);
  return held?.scope === scope && held.key === key ? held.state : LOADING;
}
