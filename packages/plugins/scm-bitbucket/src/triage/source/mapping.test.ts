import {
  TriageGetResultV1Schema,
  TriageSourceFailureV1Schema,
  TriageSourceScanObservationV1Schema,
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { decodeBitbucketPullRequestRow } from '../entries.js';
import { classifyBitbucketHttpFailure, createBitbucketFailure } from '../failures.js';
import {
  decodeBitbucketConfiguration,
  encodeBitbucketConfiguration,
} from '../instance.js';
import pageOne from '../fixtures/pullRequestsPageOne.json' with { type: 'json' };
import pullRequestSelf from '../fixtures/pullRequestSelf.json' with { type: 'json' };
import { toTriageSourceFailure } from './failures.js';
import { toBitbucketPresentObservation } from './observations.js';

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const AUTHOR_UUID = '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}';
const MAINTAINER_UUID = '{7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f}';
const OTHER_VIEWER_UUID = '{00000000-0000-4000-8000-00000000beef}';
/** The fixture participant who commented and rendered no verdict: `approved:false`, `state:null`. */
const COMMENTER_UUID = '{0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9}';
/** The fixture reviewer whose native vote is `changes_requested` — a verdict, and not an approval. */
const CHANGES_REQUESTED_REVIEWER_UUID = '{5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b}';

function decodeFixtureRow(raw: unknown) {
  const decoded = decodeBitbucketPullRequestRow(raw);
  if (!decoded.ok) throw new Error(`fixture row must decode: ${decoded.reason}`);
  return decoded.entry;
}

const OPEN_ROW = (pageOne as { values: readonly unknown[] }).values[0];
const DECLINED_ROW = (pageOne as { values: readonly unknown[] }).values[1];

describe('Bitbucket configured-instance codec', () => {
  it('round-trips only the immutable workspace UUID and encodes no account or origin', () => {
    const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid: WORKSPACE_UUID });

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeBitbucketConfiguration({ v: 1, token: encoded.token }))
      .toEqual({ v: 1, workspaceUuid: WORKSPACE_UUID });
    expect(encoded.token).not.toContain('https://');
    expect(encoded.token).not.toContain('accountId');
    // The braces are wire format: dropping one produces a request that 404s silently.
    expect(encoded.token).toContain(WORKSPACE_UUID);
  });

  it('rejects an unbraced UUID, a foreign version, an unknown member, and oversize bytes', () => {
    expect(encodeBitbucketConfiguration({
      v: 1,
      workspaceUuid: '4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44',
    }).ok).toBe(false);
    expect(decodeBitbucketConfiguration({ v: 1, token: '{"v":2,"workspaceUuid":"x"}' })).toBeNull();
    expect(decodeBitbucketConfiguration({
      v: 1,
      token: JSON.stringify({ v: 1, workspaceUuid: WORKSPACE_UUID, origin: 'https://evil.test' }),
    })).toBeNull();
    expect(decodeBitbucketConfiguration({
      v: 1,
      token: 'x'.repeat(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 + 1),
    })).toBeNull();
  });
});

describe('Bitbucket failure projection', () => {
  it('keeps a 404 non-terminal and never turns it into permission or absence', () => {
    const projected = toTriageSourceFailure(
      createBitbucketFailure('notFound', 'route-not-found', { detail: 'Repository not found' }),
    );

    expect(TriageSourceFailureV1Schema.parse(projected)).toEqual({
      class: 'unknown',
      code: 'route-not-found',
      detail: 'Repository not found',
    });
  });

  it('reports a cancelled read as retryable and preserves its own code', () => {
    expect(toTriageSourceFailure(createBitbucketFailure('cancelled', 'invocation-cancelled')))
      .toEqual({ class: 'transient', code: 'invocation-cancelled' });
  });

  it('carries the rate-limit deadline through unchanged', () => {
    expect(toTriageSourceFailure(createBitbucketFailure('rateLimit', 'request-throttled', {
      retryNotBeforeMs: 1_760_000_060_000,
    }))).toEqual({
      class: 'rateLimit',
      code: 'request-throttled',
      retryNotBeforeMs: 1_760_000_060_000,
    });
  });
});

describe('Bitbucket present-observation projection', () => {
  it('projects an open pull request through the published scan observation schema', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow(OPEN_ROW), {
      laneInvolvement: 'author',
      viewerAccountUuid: AUTHOR_UUID,
    });

    const parsed = TriageSourceScanObservationV1Schema.parse(observation);
    expect(parsed).toMatchObject({
      kind: 'present',
      localRef: {
        kindId: 'pull-request',
        collisionScope: 'bitbucket:{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}',
        entryId: '42',
      },
      snapshot: {
        state: { presentation: 'active', nativeLabel: 'Open' },
        scopeLabel: 'example-workspace/deploy-tools',
      },
      viewer: { involvement: ['author'] },
      nativeRevision: '3f6c1a8e9b24',
    });
    // Ordered by decision value, then bounded — asserted against the published bound rather than
    // against a copied number, because the bound is the contract and it has moved before.
    // `scopeLabel` already carries the repository, so no fact repeats it: with this few slots a
    // fact that restates a field already on the row spends one saying nothing new.
    const priorityOrder = [
      'bitbucket/number',
      'bitbucket/author',
      'bitbucket/reviewers',
      'bitbucket/updated',
      'bitbucket/target-branch',
      'bitbucket/comments',
      'bitbucket/tasks',
    ];
    expect(parsed.kind === 'present' && parsed.snapshot.facts.map((fact) => fact.id))
      .toEqual(priorityOrder.slice(0, MAX_TRIAGE_ROW_FACTS_V1));
    expect(parsed.kind === 'present' && parsed.snapshot.summary).toBe(
      'The poller outlived its own invocation. Bind it to the supplied signal.',
    );
    // Facts the bound dropped are reported as truncation, not silently lost.
    expect(parsed.kind === 'present' && parsed.snapshot.projectionTruncated).toBe(true);
  });

  it('reports a list-page reviewers omission as detail-only rather than as no reviewers', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow(OPEN_ROW), {
      viewerAccountUuid: OTHER_VIEWER_UUID,
    });
    // The complete reviewer set is detail-surface content in every projection, so wherever the
    // fact appears it is the deferred arm and never a rendered list of names.
    expect(observation.snapshot.facts.every((fact) => (
      fact.id !== 'bitbucket/reviewers' || fact.value.kind === 'detailOnly'
    ))).toBe(true);
    expect(observation.snapshot.facts.find((fact) => fact.id === 'bitbucket/reviewers')?.value)
      .toEqual({ kind: 'detailOnly' });
  });

  it('projects launch prose as bounded display lines instead of dropping the description', () => {
    // A real Bitbucket title can carry newlines and tabs, and a description is a whole markdown
    // document. Both are rejected by the published single-line string, so the source normalizes
    // before it projects rather than emitting a result the target parses and throws away whole.
    const observation = toBitbucketPresentObservation(decodeFixtureRow({
      id: 91,
      title: `Fix\tthe poller\r\n${'deadline handling '.repeat(40)}`,
      summary: { raw: 'Line one.\n\nLine two of the description body.' },
      destination: { repository: { uuid: '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}' } },
    }), { viewerAccountUuid: OTHER_VIEWER_UUID });

    const parsed = TriageSourceScanObservationV1Schema.parse(observation);
    if (parsed.kind !== 'present') throw new Error('fixture must project as present');
    expect(parsed.snapshot.title.startsWith('Fix the poller deadline handling')).toBe(true);
    expect(/[\u0000-\u001f\u007f]/u.test(parsed.snapshot.title)).toBe(false);
    expect(new TextEncoder().encode(parsed.snapshot.title).byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    expect(parsed.snapshot.projectionTruncated).toBe(true);
    expect(parsed.snapshot.summary).toBe('Line one. Line two of the description body.');
    expect(/[ -]/u.test(parsed.snapshot.summary ?? '')).toBe(false);
    expect(parsed.snapshot.facts.length).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACTS_V1);
  });

  it('routes through the repository locator and puts no identity or origin in the token', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow(OPEN_ROW), {
      viewerAccountUuid: OTHER_VIEWER_UUID,
    });

    const parsed = TriageSourceScanObservationV1Schema.parse(observation);
    if (parsed.kind !== 'present') throw new Error('fixture must project as present');
    // The entry key is `<scope>:<number>`, and no Bitbucket route is addressable by that pair
    // alone. The token is the repository locator verbatim — one field, nothing to read out of it.
    expect(parsed.locator.routingToken).toBe('example-workspace/deploy-tools');
    expect(parsed.locator.routingToken).not.toContain('{');
    expect(parsed.locator.routingToken).not.toContain('https://');
    expect(parsed.locator.routingToken).not.toContain(String(parsed.localRef.entryId));
  });

  it('retains the viewer own native review verdict as one bounded row fact', () => {
    // `participating` is the canonical token, and the contract requires the native label to survive
    // beside it: "approved" and "changes requested" are different answers to "what did I say?".
    const approved = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: MAINTAINER_UUID,
    });
    expect(approved.viewer.involvement).toContain('participating');
    expect(approved.snapshot.facts.find((fact) => fact.id === 'bitbucket/your-review')?.value)
      .toEqual({ kind: 'status', value: 'Approved', tone: 'success' });

    // A viewer who is only a listed reviewer has no verdict yet, so no verdict is invented.
    const uninvolved = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: OTHER_VIEWER_UUID,
    });
    expect(uninvolved.snapshot.facts.some((fact) => fact.id === 'bitbucket/your-review'))
      .toBe(false);
  });

  it('does not read a verdictless participant as having reviewed', () => {
    // Bitbucket's `participants` is every account that has interacted with the pull request, and
    // Atlassian's own contract says so: the fixture's third participant is `role: PARTICIPANT`,
    // `approved: false`, `state: null` — somebody who commented and rendered no verdict.
    // `CONTRACT.md` §4 maps only "reviewed, approved, or a non-zero native review vote" to
    // `participating`, and `sources/SCM.md` §5.5 says "participants with `approved`". Presence in
    // the array is neither. Publishing it as `participating` tells a reader they already reviewed
    // a pull request they only commented on, and puts it in their reviewed lane.
    const commenter = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: COMMENTER_UUID,
    });
    expect(commenter.viewer.involvement).toEqual([]);
    expect(commenter.snapshot.facts.some((fact) => fact.id === 'bitbucket/your-review')).toBe(false);

    // The other half of the same rule: a non-zero native vote IS a verdict, so `changes_requested`
    // still yields `participating` and keeps the provider's own word beside it. Without this the
    // fix could be "drop `participating` whenever `approved` is false", which is a different bug.
    const dissenting = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: CHANGES_REQUESTED_REVIEWER_UUID,
    });
    expect([...dissenting.viewer.involvement].sort()).toEqual(['participating', 'reviewRequested']);
    expect(dissenting.snapshot.facts.find((fact) => fact.id === 'bitbucket/your-review')?.value)
      .toEqual({ kind: 'status', value: 'Changes requested', tone: 'warning' });
  });

  it('carries the bounded description and authoritative reviewer roster into detail launch', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: MAINTAINER_UUID,
    });

    expect(observation.snapshot.summary).toBe(
      'The poller outlived its own invocation. Bind it to the supplied signal.',
    );
    expect(observation.snapshot.facts.find((fact) => fact.id === 'bitbucket/reviewers')?.value)
      .toEqual({ kind: 'text', value: 'Example Maintainer, Example Reviewer' });
  });

  it('keeps a declined pull request present and closed with the provider word', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow(DECLINED_ROW), {
      viewerAccountUuid: OTHER_VIEWER_UUID,
    });

    expect(observation.snapshot.state).toEqual({ presentation: 'closed', nativeLabel: 'Declined' });
    expect(TriageGetResultV1Schema.parse(observation)).toBeTruthy();
  });

  it('proves involvement against the credential instead of trusting the lane alone', () => {
    // The authoritative `self` shape carries `reviewers` and `participants` without being asked, so
    // it is where the viewer's own involvement is corroborated rather than assumed. A collection
    // page fetched with the participants projection carries the same evidence in the same shape.
    const asReviewer = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      laneInvolvement: 'reviewRequested',
      viewerAccountUuid: MAINTAINER_UUID,
    });
    expect([...asReviewer.viewer.involvement].sort())
      .toEqual(['participating', 'reviewRequested']);

    // No lane token at all, and the viewer is still recognised as the author from the row itself.
    const asAuthor = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: AUTHOR_UUID,
    });
    expect([...asAuthor.viewer.involvement]).toEqual(['author']);

    // An uninvolved viewer gets an empty set rather than the lane's optimistic token.
    const asStranger = toBitbucketPresentObservation(decodeFixtureRow(pullRequestSelf), {
      viewerAccountUuid: OTHER_VIEWER_UUID,
    });
    expect(asStranger.viewer.involvement).toEqual([]);
  });

  it('keeps an identity-valid entry present when every presentation field is missing', () => {
    const observation = toBitbucketPresentObservation(decodeFixtureRow({
      id: 7,
      destination: {
        repository: { uuid: '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}' },
      },
    }), { viewerAccountUuid: OTHER_VIEWER_UUID });

    const parsed = TriageSourceScanObservationV1Schema.parse(observation);
    expect(parsed).toMatchObject({
      kind: 'present',
      snapshot: {
        title: 'Pull request #7',
        scopeLabel: '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}',
        state: { presentation: 'unknown', nativeLabel: 'Unknown' },
      },
    });
    const available = ['bitbucket/number', 'bitbucket/reviewers'];
    expect(parsed.kind === 'present' && parsed.snapshot.facts.map((fact) => fact.id))
      .toEqual(available.slice(0, MAX_TRIAGE_ROW_FACTS_V1));
    // Nothing was dropped here, so nothing claims it was.
    expect(parsed.kind === 'present' && parsed.snapshot.projectionTruncated)
      .toBe(available.length > MAX_TRIAGE_ROW_FACTS_V1 ? true : undefined);
  });
});

describe('Bitbucket failure detail bounds', () => {
  it('bounds a provider error message to the published failure-detail bound', () => {
    // The published bound is the only ledger. A source-local ceiling that merely
    // happened to agree once produces a detail the strict target rejects, and the
    // rejection is atomic — the whole scan result is lost, not just its detail.
    const projected = toTriageSourceFailure(classifyBitbucketHttpFailure({
      status: 500,
      headers: {},
      body: { error: { message: 'm'.repeat(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1 + 1) } },
      nowMs: 1_760_000_000_000,
    }));

    expect(new TextEncoder().encode(projected.detail ?? '').byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1);
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });

  it('publishes a multi-line provider error message as one line', () => {
    const projected = toTriageSourceFailure(classifyBitbucketHttpFailure({
      status: 500,
      headers: {},
      body: { error: { message: 'Internal error\n  request id 7f3a' } },
      nowMs: 1_760_000_000_000,
    }));

    expect(projected.detail).toBe('Internal error request id 7f3a');
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });
});
