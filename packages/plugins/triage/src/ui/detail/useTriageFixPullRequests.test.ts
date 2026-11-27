import { describe, expect, it } from 'vitest';
import { createActionTriageFixPullRequestsTransport } from './useTriageFixPullRequests.js';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { readTriageExactFixPullRequest } from './useTriageDetailFixPullRequest.js';
import { projectTriageFixPullRequestsRead } from '../../projection/fixPullRequests.js';
import { TriageReadFixPullRequestsResultV1Schema } from '@happier-dev/triage-protocol/v1';

describe('fix-link Action transport', () => {
  it('retains keyed candidate identities after fresh Action replies, projects only changed values and preserves reorder', async () => {
    const fixture = createTriageSourceV1Fixture();
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      entryRef: { ...fixture.detailInput.observation.entryRef, entryId: String(index) },
      origins: ['native'], status: 'open', display: { title: `Fix ${index}` },
      sourceContext: { sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId, lastKnownLocator: fixture.detailInput.observation.locator },
    }));
    let reply = { v: 1, candidates, primary: candidates[0], incomplete: false };
    // Only the Account Action transport is replaced; real strict admission and projection run.
    const transport = createActionTriageFixPullRequestsTransport({ executeAction: async () => JSON.parse(JSON.stringify(reply)) });
    const baseline = projectTriageFixPullRequestsRead(await transport.read(fixture.detailInput.observation.entryRef));
    for (let refresh = 0; refresh < 5; refresh++) {
      const equal = projectTriageFixPullRequestsRead(await transport.read(fixture.detailInput.observation.entryRef), baseline);
      expect(equal).toBe(baseline);
      expect(equal.candidates.filter((candidate, index) => candidate !== baseline.candidates[index])).toHaveLength(0);
    }
    reply = { ...reply, candidates: candidates.map((candidate, index) => index === 500 ? { ...candidate, status: 'merged' } : candidate) };
    const changed = projectTriageFixPullRequestsRead(await transport.read(fixture.detailInput.observation.entryRef), baseline);
    expect(changed.candidates.filter((candidate, index) => candidate !== baseline.candidates[index])).toHaveLength(1);
    expect(changed.candidates[500]?.status).toBe('merged');
    expect(changed.candidates[500]?.entryRef).toBe(baseline.candidates[500]?.entryRef);
    expect(changed.candidates[500]?.display).toBe(baseline.candidates[500]?.display);
    expect(changed.candidates[500]?.origins).toBe(baseline.candidates[500]?.origins);
    expect(changed.candidates[500]?.sourceContext).toBe(baseline.candidates[500]?.sourceContext);
    reply = { ...reply, candidates: [...candidates].reverse() };
    const reordered = projectTriageFixPullRequestsRead(await transport.read(fixture.detailInput.observation.entryRef), baseline);
    expect(reordered.candidates).toEqual([...baseline.candidates].reverse());
    expect(reordered.candidates.every((candidate, index) => candidate === baseline.candidates[999 - index])).toBe(true);
    expect(reordered.primary).toBe(baseline.primary);
    const denied = projectTriageFixPullRequestsRead(TriageReadFixPullRequestsResultV1Schema.parse({ ...reply, incomplete: true }), reordered);
    expect(denied).not.toBe(reordered);
    expect(denied.incomplete).toBe(true);
    expect(denied.candidates).toBe(reordered.candidates);
    const nativeFailure = { class: 'permission', code: 'provider_denied', requestId: 'native-fix-pr-41' } as const;
    const refused = projectTriageFixPullRequestsRead(TriageReadFixPullRequestsResultV1Schema.parse({
      ...reply, incomplete: true, nativeFailure,
    }), denied);
    expect(refused.nativeFailure).toEqual(nativeFailure);
    expect(refused.candidates).toBe(denied.candidates);
    expect(projectTriageFixPullRequestsRead(denied, refused).nativeFailure).toBeUndefined();
    const rerouted = projectTriageFixPullRequestsRead(TriageReadFixPullRequestsResultV1Schema.parse({ ...reply,
      candidates: reply.candidates.map((candidate, index) => index === 500 ? { ...candidate,
        sourceContext: { ...candidate.sourceContext, lastKnownLocator: { ...candidate.sourceContext.lastKnownLocator, routingToken: 'changed-route' } },
      } : candidate),
    }), reordered);
    expect(rerouted.candidates.filter((candidate, index) => candidate !== reordered.candidates[index])).toHaveLength(1);
    expect(rerouted.candidates[500]?.sourceContext?.lastKnownLocator.routingToken).toBe('changed-route');
    expect(rerouted.candidates[500]?.display).toBe(reordered.candidates[500]?.display);
    const removed = projectTriageFixPullRequestsRead(TriageReadFixPullRequestsResultV1Schema.parse({ ...reply,
      candidates: reply.candidates.slice(1),
    }), reordered);
    expect(removed.candidates).toHaveLength(999);
    expect(removed.candidates.every((candidate, index) => candidate === reordered.candidates[index + 1])).toBe(true);
  });
  it('opens an off-page native PR by one exact admitted read and refuses a mismatched result', async () => {
    const fixture = createTriageSourceV1Fixture();
    const observation = fixture.detailInput.observation;
    const candidate = { entryRef: observation.entryRef, origins: ['native' as const], status: 'open' as const, display: {},
      sourceContext: { sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId, lastKnownLocator: observation.locator } };
    const requests: unknown[] = [];
    const host = { executeAction: async (action: string, input: unknown) => {
      requests.push({ action, input });
      return { kind: 'observed', entryRef: observation.entryRef,
        observation: { sourceInstanceId: candidate.sourceContext.sourceInstanceId, observedAtMs: observation.observedAtMs,
          outcome: { kind: 'present', locator: observation.locator, snapshot: observation.snapshot, viewer: observation.viewer,
            ...(observation.sourceUpdatedAtMs === undefined ? {} : { sourceUpdatedAtMs: observation.sourceUpdatedAtMs }) } } };
    } };
    const { nativeRevision: _nativeRevision, ...wireObservation } = observation;
    expect(await readTriageExactFixPullRequest(host, candidate)).toEqual({ sourceInstanceId: candidate.sourceContext.sourceInstanceId, observation: wireObservation });
    expect(requests).toEqual([{ action: 'entries/reobserve-v1', input: { v: 1, entryRef: candidate.entryRef, ...candidate.sourceContext } }]);
    expect(await readTriageExactFixPullRequest(host, { ...candidate, entryRef: { ...candidate.entryRef, entryId: 'other' } })).toBeNull();
  });
  it('passes selected source context to the canonical Account read and writes through its Action', async () => {
    const fixture = createTriageSourceV1Fixture();
    const entryRef = fixture.detailInput.observation.entryRef;
    const sourceContext = { instance: fixture.configuredInstance,
      lastKnownLocator: fixture.detailInput.observation.locator };
    const requests: unknown[] = [];
    const transport = createActionTriageFixPullRequestsTransport({ executeAction: async (action, input) => {
      requests.push({ action, input });
      return action === 'marks/read-fix-pull-requests-v1' ? { v: 1, candidates: [], primary: null, incomplete: true }
        : { v: 1, status: 'unlinked' };
    } }, sourceContext);
    expect(await transport.read(entryRef)).toEqual({ v: 1, candidates: [], primary: null, incomplete: true });
    const intent = { v: 1 as const, linked: false as const, entryRef, fixPullRequest: entryRef,
      displayAtMark: { title: 'Finding', scopeLabel: 'Repository' } };
    expect(await transport.write(intent)).toEqual({ v: 1, status: 'unlinked' });
    expect(requests).toEqual([
      { action: 'marks/read-fix-pull-requests-v1', input: { v: 1, entryRef, sourceContext } },
      { action: 'marks/set-fix-pull-request-v1', input: intent },
    ]);
  });
});
