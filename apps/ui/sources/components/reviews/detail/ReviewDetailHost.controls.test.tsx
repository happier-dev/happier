import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewReviewersSetInputV1Schema, type ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { deriveReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema,
  ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema,
  type ReviewCommentPrepareMutationResponseV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { readReviewFindingDecisionV1 } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it('mounts semantic finding selection, filter, tab and open commands against the opened Review', async () => {
  const reviewId = 'semantic-review-controls';
  const root = buildReviewCommentFixture({ id: 'semantic-root', threadId: 'semantic-root', reviewId,
    accountId: 'alice', state: 'open', roundOrdinal: 1, findingIdentity: '4'.repeat(64),
    finding: { id: 'semantic-finding', title: 'Semantic finding', summary: 'Opened finding', severity: 'high', category: 'correctness' } });
  const accepted = buildReviewCommentFixture({ id: 'semantic-accepted', threadId: 'semantic-accepted', reviewId,
    accountId: 'alice', state: 'open', reviewTriageStatus: 'accept', roundOrdinal: 1, findingIdentity: '5'.repeat(64),
    finding: { id: 'semantic-accepted-finding', title: 'Accepted finding', summary: 'Already accepted', severity: 'high', category: 'correctness' } });
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://semantic-review-controls.test', request: async url => {
    if (new URL(String(url)).pathname === '/v1/reviews/comments') return Response.json({ items: [root, accepted].map(storePlainReviewCommentFixture), cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Semantic controls', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Semantic controls' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { ReviewFindingRow } = await import('@/components/sessions/reviews/findings/ReviewFindingRow');
  let commands: ReturnType<typeof useCurrentUiContextComposedCommands> = [];
  function ObserveCommands() { commands = useCurrentUiContextComposedCommands(); return null; }
  function OpenReview() {
    const { binding } = useServerCredentialAccountScopeBinding(artifact.sourceServerId);
    return <CurrentUiContextCommandsProvider authority={binding}>
      <ObserveCommands /><ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />
    </CurrentUiContextCommandsProvider>;
  }
  const screen = await fixture.render(<OpenReview />);
  const invoke = async (description: string, input: Record<string, string | string[]>) => {
    const command = commands.find(row => row.description?.includes(description))?.command;
    if (command?.kind !== 'hostLocal') throw new Error(`Missing mounted Review command: ${description}`);
    await act(async () => { expect(await command.invoke({ input, signal: new AbortController().signal,
      context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
  };
  try {
    await vi.waitFor(() => expect(screen.findAllByType(ReviewFindingRow)).toHaveLength(2));
    await invoke('Select canonical finding roots', { rowIds: [root.id] });
    expect(screen.findHostByTestId(`review-findings:select:${root.id}`)?.props.accessibilityState.checked).toBe(true);
    await invoke('Filter findings', { filter: 'accept' });
    expect(screen.findAllByType(ReviewFindingRow).map(row => row.props.rowId)).toEqual([accepted.id]);
    await invoke('Filter findings', { filter: 'all' });
    await invoke('Open a finding', { commentId: root.id });
    expect(screen.findAllByType(ReviewFindingRow).find(row => row.props.rowId === root.id)?.props.expanded).toBe(true);
    await invoke('Open a Review tab', { tab: 'activity' });
    expect(screen.findByType(ReviewDetailView).props.activeTab).toBe('activity');
    await invoke('Open a Review tab', { tab: 'findings' });
    expect(screen.findHostByTestId(`review-findings:select:${root.id}`)?.props.accessibilityState.checked).toBe(true);
  } finally { await screen.unmount(); }
});

it('leads with one Implement primary while findings await, and keeps selection behind Select', async () => {
  const reviewId = 'one-primary-review';
  const pending = buildReviewCommentFixture({ id: 'pending-root', threadId: 'pending-root', reviewId,
    accountId: 'alice', state: 'open', roundOrdinal: 1, findingIdentity: '6'.repeat(64),
    finding: { id: 'pending-finding', title: 'Pending finding', summary: 'Waiting for a decision', severity: 'high', category: 'correctness' } });
  const accepted = buildReviewCommentFixture({ id: 'accepted-root', threadId: 'accepted-root', reviewId,
    accountId: 'alice', state: 'open', reviewTriageStatus: 'accept', roundOrdinal: 1, findingIdentity: '7'.repeat(64),
    finding: { id: 'accepted-finding', title: 'Accepted finding', summary: 'To implement', severity: 'high', category: 'correctness' } });
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://one-primary-review.test', request: async url => {
    if (new URL(String(url)).pathname === '/v1/reviews/comments') return Response.json({ items: [pending, accepted].map(storePlainReviewCommentFixture), cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'One primary', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'One primary' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { ReviewFindingRow } = await import('@/components/sessions/reviews/findings/ReviewFindingRow');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(ReviewFindingRow)).toHaveLength(2));
    // One primary: the header names the fixes; no second Implement inside the tab, New round waits in "…".
    expect(screen.findByType(ReviewDetailView).props.primaryAction?.title).toBe(t('runPage.review.implementFixes', { count: 1 }));
    expect(screen.findHostByTestId('review-detail:implement')).toBeNull();
    // At rest each finding shows its status glyph only; Select reveals the checkboxes.
    expect(screen.findHostByTestId('review-findings:select:pending-root')).toBeNull();
    await screen.pressByTestIdAsync('review-findings:select-mode');
    expect(screen.findHostByTestId('review-findings:select:pending-root')?.props.accessibilityState.checked).toBe(false);
  } finally { await screen.unmount(); }
});

it('shows a fixed finding as Fixed, counts it on its chip and never offers to implement it again', async () => {
  const reviewId = 'fixed-finding-review';
  const fixed = buildReviewCommentFixture({ id: 'fixed-root', threadId: 'fixed-root', reviewId,
    accountId: 'alice', state: 'resolved', reviewTriageStatus: 'accept', roundOrdinal: 1, findingIdentity: '8'.repeat(64),
    finding: { id: 'fixed-finding', title: 'Fixed finding', summary: 'Already fixed', severity: 'high', category: 'correctness' } });
  const pending = buildReviewCommentFixture({ id: 'still-pending', threadId: 'still-pending', reviewId,
    accountId: 'alice', state: 'open', roundOrdinal: 1, findingIdentity: '9'.repeat(64),
    finding: { id: 'still-pending-finding', title: 'Pending finding', summary: 'Waiting', severity: 'medium', category: 'correctness' } });
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://fixed-finding-review.test', request: async url => {
    if (new URL(String(url)).pathname === '/v1/reviews/comments') return Response.json({ items: [fixed, pending].map(storePlainReviewCommentFixture), cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Fixed finding', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Fixed finding' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { ReviewFindingRow } = await import('@/components/sessions/reviews/findings/ReviewFindingRow');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(ReviewFindingRow)).toHaveLength(2));
    const row = screen.findAllByType(ReviewFindingRow).find(item => item.props.rowId === fixed.id)!;
    // The fixed row reads Fixed and offers no decision (Implement) control.
    expect(row.props.resolution).toBe(t('reviewWalkthrough.detail.fixed'));
    expect(row.props.decisionEditable).toBe(false);
    // Nothing is left to implement and one finding still waits: no header primary, no Implement anywhere.
    const view = screen.findByType(ReviewDetailView);
    expect(view.props.primaryAction ?? null).toBeNull();
    expect(view.props.menu.some((item: { id: string }) => item.id === 'implement')).toBe(false);
    expect(screen.findHostByTestId('review-findings:filter:fixed')).not.toBeNull();
  } finally { await screen.unmount(); }
});

it('says the Review is shared, with whom through the Artifact audience owner, and offers Share and Delete in its "…"', async () => {
  const reviewId = 'shared-review-page';
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://shared-review-page.test', request: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Shared review', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Shared review' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  fixture.artifacts.seedAccountGrant(reviewId, 'bob', 'view');
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    // A Team grant reads "Shared with ⟨Team⟩" through the same audience owner (useApprovalProfileAudience test).
    await vi.waitFor(() => expect(screen.findByType(ReviewDetailView).props.meta).toContainEqual(
      expect.objectContaining({ key: 'audience', text: t('artifacts.browser.facts.shared') })));
    const menu = screen.findByType(ReviewDetailView).props.menu.map((item: { id: string }) => item.id);
    expect(menu).toEqual(expect.arrayContaining(['share', 'delete']));
  } finally { await screen.unmount(); }
});

it.each([
  { decision: 'needs_refinement', expected: 'undecided' },
  { decision: 'defer', expected: 'defer' },
] as const)('returns an ignored native finding to $expected through the selected bulk Action and persisted read', async ({ decision, expected }) => {
  const reviewId = `native-bulk-${decision}`;
  const roots = ['selected', 'unselected'].map((id, index) => buildReviewCommentFixture({ id, threadId: id, reviewId,
    accountId: 'alice', state: 'dismissed', reviewTriageStatus: 'accept', roundOrdinal: 1,
    findingIdentity: String(index + 1).repeat(64), finding: { id: `finding-${id}`, title: id,
      summary: `Explanation for ${id}`, severity: 'high', category: 'correctness' } }));
  const stored = new Map(roots.map(root => [root.id, storePlainReviewCommentFixture(root)]));
  const prepared: ReviewCommentPrepareMutationResponseV1[] = [];
  fixture = await createSessionFilesViewFixture({ serverUrl: `https://${reviewId}.test`, request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/mutations/prepare')) {
      const request = ReviewCommentPrepareMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
      const derived = deriveReviewCommentStructuralMutationV1({ mutation: request.mutation, accountId: 'alice',
        actor: { kind: 'user', userId: 'alice' }, current: [...stored.values()].map(row => row.structural),
        runtime: { now: () => 10, createId: prefix => `${prefix}-selected` } });
      const response = ReviewCommentPrepareMutationResponseV1Schema.parse({ v: 1, request, receipt: 'native-bulk', replayed: false,
        ...derived, records: derived.records.map(record => ({ ...record, previous: { structural: stored.get(record.structural.id)!.structural,
          source: { v: 1, layout: 'canonical_v1', envelope: stored.get(record.structural.id)!.sensitiveEnvelope } } })) });
      prepared.push(response);
      return Response.json(response);
    }
    if (path.endsWith('/mutations/commit')) {
      const request = ReviewCommentCommitMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
      const response = prepared.at(-1)!;
      const comments = request.records.map(record => ({ v: 1 as const,
        structural: response.records.find(item => item.structural.id === record.commentId)!.structural,
        sensitiveEnvelope: record.sensitiveEnvelope }));
      for (const row of comments) stored.set(row.structural.id, row);
      return Response.json({ v: 1, replayed: false, failed: response.failed, bulkActionId: response.bulkActionId, comments });
    }
    if (path === '/v1/reviews/comments') return Response.json({ items: [...stored.values()], cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Selected finding recovery', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Selected finding recovery' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewFindingRow } = await import('@/components/sessions/reviews/findings/ReviewFindingRow');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(ReviewFindingRow)).toHaveLength(2));
    await screen.pressByTestIdAsync('review-findings:select-mode');
    await screen.pressByTestIdAsync('review-findings:select:selected');
    await screen.pressByTestIdAsync(`review-detail:bulk:${decision}`);
    await vi.waitFor(() => expect(stored.get('selected')!.structural.state).toBe('open'));
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.request.mutation).toMatchObject({ actionId: 'reviews.comments.bulkTransition',
      input: { commentIds: ['selected'], reviewTriageStatus: decision } });
    const persisted = stored.get('selected')!;
    expect(persisted.sensitiveEnvelope.t).toBe('plain');
    if (persisted.sensitiveEnvelope.t !== 'plain') throw new Error('Expected plain fixture content');
    expect(readReviewFindingDecisionV1(persisted.structural.reviewTriageStatus, persisted.structural.state)).toBe(expected);
    expect(stored.get('unselected')!.structural.state).toBe('dismissed');
    await vi.waitFor(() => expect(screen.findAllByType(ReviewFindingRow).find(row => row.props.rowId === 'selected')?.props.decision).toBe(expected));
  } finally { await screen.unmount(); }
});

it.each(['http', 'transport'] as const)('edits the opened round’s requested people through the reviewer Action and preserves the draft on %s failure', async failure => {
  const reviewId = 'requested-people-review';
  let human: ReviewHumanStateV1 = { reviewId, roundOrdinal: 2,
    requests: [{ id: 'requested-bob', roundOrdinal: 2, principal: { kind: 'account', accountId: 'bob' }, required: true, needsAccess: true }],
    verdicts: [], needsYou: { reviewId, roundOrdinal: 2, reason: 'review_needs_you', needsYou: false,
      requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } };
  const writes: unknown[] = [];
  let fail = true;
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://review-detail-controls.test', request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/reviews/get') return Response.json({
      review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
        currentRoundOrdinal: 2, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 } }, human });
    if (path === `/v1/reviews/${reviewId}/reviewers`) {
      writes.push(JSON.parse(String(init?.body)));
      if (fail) {
        if (failure === 'transport') throw new TypeError('Network request failed');
        return Response.json({ error: 'Unavailable' }, { status: 503 });
      }
      const input = ReviewReviewersSetInputV1Schema.parse({ reviewId, ...JSON.parse(String(init?.body)) });
      human = { ...human, requests: input.reviewers.map((reviewer, index) => ({ ...reviewer, id: `requested-${index}`,
        roundOrdinal: input.roundOrdinal, needsAccess: true })) };
      return Response.json(human);
    }
    if (path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Requested people', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Requested people' },
    body: JSON.stringify({ v: 1, rounds: [1, 2].map(ordinal => ({ ordinal, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] })) }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    const edit = () => screen.findByType(ReviewDetailView).props.menu.find((entry: { id: string }) => entry.id === 'edit-reviewers');
    await vi.waitFor(() => expect(edit()).toMatchObject({ disabled: false }));
    expect(screen.findByType(ReviewDetailView).props.rounds[1].groups.find((group: { id: string }) => group.id === 'people').participants[0].qualifier).toContain(t('reviewWalkthrough.detail.needsAccess'));
    await act(async () => { edit().onSelect(); });
    await screen.pressByTestIdAsync('review-people:required:account:bob');
    await screen.pressByTestIdAsync('review-people:save');
    expect(writes).toEqual([{ roundOrdinal: 2, reviewers: [{ principal: { kind: 'account', accountId: 'bob' }, required: false }] }]);
    expect(screen.findHostByTestId('review-people:required:account:bob')?.props.accessibilityState.checked).toBe(false);
    expect(screen.findHostByTestId('review-people:required:account:bob')?.props['aria-checked']).toBe(false);
    fail = false;
    await screen.pressByTestIdAsync('review-people:save');
    expect(writes).toHaveLength(2);
    expect(screen.findByTestId('review-people')).toBeNull();
    await vi.waitFor(() => expect(screen.findByType(ReviewDetailView).props.rounds[1].groups.find((group: { id: string }) => group.id === 'people').participants[0].qualifier).toContain(t('reviewWalkthrough.detail.optional')));
  } finally { await screen.unmount(); }
});
