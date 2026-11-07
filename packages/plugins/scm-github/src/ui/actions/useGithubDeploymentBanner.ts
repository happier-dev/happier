import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { forgeCiRunKeyV1, readForgeCiSelectionRunV1, type ForgeCiReadLeaseV1, type ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { sameScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import type { ForgeCiDeploymentApprovalV1, ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

export type GithubDeploymentBannerEntryV1 = Readonly<{ run: ForgeCiRunV1; approval: ForgeCiDeploymentApprovalV1 }>;
export type GithubDeploymentBannerUnavailableV1 = Readonly<{
  run: ForgeCiRunV1;
  reason: 'loading' | 'failed' | 'incomplete' | 'retired';
  failure: TriageSourceFailureV1 | null;
}>;
export type GithubDeploymentBannerV1 = Readonly<{
  /** This is the presented waiting-run window, never a repository-wide total. */
  entries: readonly GithubDeploymentBannerEntryV1[];
  /** Failed or not-yet-admitted reads are unknown, not an empty approval set. */
  unavailable: readonly GithubDeploymentBannerUnavailableV1[];
  pending: boolean;
  refresh(): Promise<void>;
}>;

type Demand = { run: ForgeCiRunV1; lease: ForgeCiReadLeaseV1<'listDeployments'>; unsubscribe(): void };
const sameRows = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((row, index) => row === right[index]);

/** Aggregate only demand: HTTP, retention, currentness and scheduling remain
 * with the same exact-run query owner used by the review card. */
function createBannerDemand(reads: ForgeCiReadsV1 | null, repository: ScmHostingRepositoryIdentityV1, signal: AbortSignal) {
  const demands = new Map<string, Demand>();
  const listeners = new Set<() => void>();
  const refresh = async () => { await Promise.all([...demands.values()].map(demand => demand.lease.refresh())); };
  let snapshot: GithubDeploymentBannerV1 = { entries: [], unavailable: [], pending: false, refresh };
  function publish() {
    const entries: GithubDeploymentBannerEntryV1[] = [];
    const unavailable: GithubDeploymentBannerUnavailableV1[] = [];
    const priorEntries = new Map(snapshot.entries.map(value => [JSON.stringify([forgeCiRunKeyV1(value.run.ref), value.approval.id]), value]));
    const priorUnavailable = new Map(snapshot.unavailable.map(value => [forgeCiRunKeyV1(value.run.ref), value]));
    let pending = false;
    for (const { run, lease } of demands.values()) {
      const status = lease.getSnapshot();
      pending ||= status.pending;
      const reason = status.retired ? 'retired' : status.failure !== null ? 'failed' : status.value === null ? 'loading'
        : status.value.incomplete !== null || status.value.continuation !== null || status.value.omittedRowCount > 0 || status.value.projectionTruncated ? 'incomplete' : null;
      if (reason !== null) {
        const previous = priorUnavailable.get(forgeCiRunKeyV1(run.ref));
        unavailable.push(previous?.run === run && previous.failure === status.failure && previous.reason === reason
          ? previous : { run, reason, failure: status.failure });
      }
      if (status.retired) continue;
      for (const approval of status.value?.rows ?? []) {
        if (!approval.eligible || forgeCiRunKeyV1(readForgeCiSelectionRunV1(approval.selection)) !== forgeCiRunKeyV1(run.ref)) continue;
        const previous = priorEntries.get(JSON.stringify([forgeCiRunKeyV1(run.ref), approval.id]));
        entries.push(previous?.run === run && previous.approval === approval ? previous : { run, approval });
      }
    }
    if (pending === snapshot.pending && sameRows(entries, snapshot.entries) && sameRows(unavailable, snapshot.unavailable)) return;
    snapshot = { entries: sameRows(entries, snapshot.entries) ? snapshot.entries : entries,
      unavailable: sameRows(unavailable, snapshot.unavailable) ? snapshot.unavailable : unavailable, pending, refresh };
    for (const listener of listeners) listener();
  }
  function clear() {
    for (const demand of demands.values()) { demand.unsubscribe(); demand.lease.release(); }
    demands.clear();
    publish();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear,
    setRuns(runs: readonly ForgeCiRunV1[], enabled: boolean) {
      const candidates = new Map<string, ForgeCiRunV1>();
      if (enabled && !signal.aborted && reads) for (const run of runs) {
        if (run.state.phase === 'waiting' && sameScmHostingRepositoryIdentity(repository, run.ref.repository)) candidates.set(forgeCiRunKeyV1(run.ref), run);
      }
      for (const [key, demand] of demands) if (!candidates.has(key)) {
        demand.unsubscribe(); demand.lease.release(); demands.delete(key);
      }
      for (const [key, run] of candidates) {
        const held = demands.get(key);
        if (held) { held.run = run; continue; }
        const lease = reads!.acquire('listDeployments', { repository, runId: run.ref.runId }, { signal });
        demands.set(key, { run, lease, unsubscribe: lease.subscribe(publish) });
      }
      publish();
    },
  };
}

/** Only presented native waiting candidates request pending environments.
 * A waiting phase alone never becomes a positive review banner. */
export function useGithubDeploymentBannerV1(input: Readonly<{
  reads: ForgeCiReadsV1 | null;
  repository: ScmHostingRepositoryIdentityV1;
  runs: readonly ForgeCiRunV1[];
  enabled: boolean;
  signal: AbortSignal;
}>): GithubDeploymentBannerV1 {
  const { active } = usePluginSurfaceActivity();
  const { reads, repository, signal, runs, enabled } = input;
  const owner = useMemo(() => createBannerDemand(reads, repository, signal),
    [reads, repository.kind, repository.deployment, repository.repository, signal]);
  useEffect(() => {
    const retire = () => owner.clear();
    signal.addEventListener('abort', retire, { once: true });
    return () => { signal.removeEventListener('abort', retire); owner.clear(); };
  }, [owner, signal]);
  useEffect(() => { owner.setRuns(runs, enabled && active); }, [owner, runs, enabled, active]);
  return useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}
