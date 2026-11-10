import type {
  TriageGetInputV1,
  TriageGetResultV1,
} from '@happier-dev/triage-protocol/v1';

import type { BitbucketSourceRuntime } from './authorization.js';
import { readBitbucketBuildsPage } from '../detail/reads.js';
import { admitBitbucketEntryInvocation } from './invocationAdmission.js';
import { observeBitbucketEntry } from './observeEntry.js';
import { buildBitbucketBuildFact } from './observations.js';

/**
 * Bitbucket Cloud V1 never concludes absence.
 *
 * Under one credential the API cannot distinguish a pull request that was removed from one this
 * caller cannot see, so repository readability is not a deletion proof. Every non-success — a `404`
 * included — is `unresolved`, and a declined or superseded pull request is `present` with its state.
 */
export async function getBitbucketSourceEntry(
  runtime: BitbucketSourceRuntime,
  input: TriageGetInputV1,
): Promise<TriageGetResultV1> {
  // Admission has ONE owner. This function used to carry a complete inline copy
  // of the sequence — kind, purpose, configuration, instance key, collision
  // scope, authorization — and the copy had never grown the entry-id gate, so a
  // ref the detail and mutation paths refused was accepted here and reached the
  // provider as a malformed route. `invocationAdmission.ts` says exactly this in
  // its own docstring: two copies would be two answers, and the copy that
  // drifted would be the one guarding a write.
  const admitted = await admitBitbucketEntryInvocation({
    instance: input.instance,
    localRef: input.localRef,
    lastKnownLocator: input.lastKnownLocator,
  }, runtime);
  if (!admitted.ok) {
    return { kind: 'unresolved', localRef: input.localRef, failure: admitted.failure };
  }

  // The viewer read, the pull-request read, the projection and the returned-ref check all belong to
  // the one entry-observation owner, which the mutations reach for their currentness and confirming
  // reads. Two copies of it would be two answers to the same question about the same entry.
  const observation = await observeBitbucketEntry({
    client: admitted.client,
    route: admitted.route,
    localRef: input.localRef,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (observation.kind !== 'present') return observation;

  // Only an exact detail get asks for builds. Shared mutation observations keep
  // their existing currentness/confirmation reads without a status-page fetch.
  const builds = await readBitbucketBuildsPage({ route: admitted.route, position: { kind: 'first' } }, {
    client: admitted.client,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  const fact = buildBitbucketBuildFact(builds.ok ? builds.value.rollup : null);
  return fact === null ? observation : {
    ...observation,
    snapshot: { ...observation.snapshot, facts: [...observation.snapshot.facts, fact] },
  };
}
