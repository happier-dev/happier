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
    // Selecting, the row is the checkbox: its check takes the glyph's place, so it no longer opens the finding.
    expect(screen.findHostByTestId('review-finding-toggle:pending-root')).toBeNull();
    // The bottom bar holds the decision verbs only; applying the decided fixes stays the header's one primary.
    expect(screen.findHostByTestId('review-detail:bulk:accept')).not.toBeNull();
    expect(screen.findHostByTestId('review-detail:bulk:implement')).toBeNull();
  } finally { await screen.unmount(); }
});

it('shows a fixed finding as Fixed, counts it on its chip and never offers to implement it again', async () => {
  const reviewId = 'fixed-finding-review';
  const roundSummary = 'Captured round verification';
  const fixed = buildReviewCommentFixture({ id: 'fixed-root', threadId: 'fixed-root', reviewId,
    accountId: 'alice', state: 'resolved', reviewTriageStatus: 'accept', roundOrdinal: 1, findingIdentity: '8'.repeat(64),
    finding: { id: 'fixed-finding', title: 'Fixed finding', summary: 'Already fixed', severity: 'high', category: 'correctness' } });
  const pending = buildReviewCommentFixture({ id: 'still-pending', threadId: 'still-pending', reviewId,
    accountId: 'alice', state: 'open', roundOrdinal: 1, findingIdentity: '9'.repeat(64),
    finding: { id: 'still-pending-finding', title: 'Pending finding', summary: 'Waiting', severity: 'medium', category: 'correctness' } });
  const human: ReviewHumanStateV1 = { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
    needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: true, requestedVerdict: false,
      pendingDecisions: true, canSubmitVerdict: false } };
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://fixed-finding-review.test', request: async url => {
    if (new URL(String(url)).pathname === '/v1/reviews/get') return Response.json({
      review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
        counts: { total: 2, needsDecision: 1 } }, human });
    if (new URL(String(url)).pathname === '/v1/reviews/comments') return Response.json({ items: [fixed, pending].map(storePlainReviewCommentFixture), cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Fixed finding', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Fixed finding' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [], summary: roundSummary }] }),
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
    // Totals belong to the filter chips; the shared glance keeps the verdict followed by the round's facts.
    expect(screen.findHostByTestId('review-findings:filter:all')?.props.accessibilityLabel).toBe(`${t('common.all')} 2`);
    expect(screen.findHostByTestId('review-findings:filter:fixed')?.props.accessibilityLabel).toBe(`${t('reviewWalkthrough.detail.fixed')} 1`);
    const facts = screen.findHostByTestId('review-detail:facts');
    expect(facts?.children).toEqual([roundSummary]);
    const verdict = screen.findHostByTestId('review-detail:glance');
    const lines = verdict?.findAll(node => typeof node.type === 'string'
      && (node.props.testID === 'review-detail:facts' || node.children.includes(view.props.glance.sentence)));
    expect(lines?.map(node => node === facts ? 'facts' : 'verdict')).toEqual(['verdict', 'facts']);
  } finally { await screen.unmount(); }
});

it('offers no primary from a Review still loading: never New round, and no placeholder until the real one lands (G, U8 R5 B6)', async () => {
  const reviewId = 'loading-primary-review';
  const accepted = buildReviewCommentFixture({ id: 'loading-accepted', threadId: 'loading-accepted', reviewId,
    accountId: 'alice', state: 'open', reviewTriageStatus: 'accept', roundOrdinal: 1, findingIdentity: 'a'.repeat(64),
    finding: { id: 'loading-accepted-finding', title: 'Accepted finding', summary: 'To implement', severity: 'high', category: 'correctness' } });
  const human: ReviewHumanStateV1 = { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
    needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false, requestedVerdict: false,
      pendingDecisions: false, canSubmitVerdict: false } };
  const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { open, opened }; };
  const detailRead = gate();
  const commentsRead = gate();
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://loading-primary-review.test', request: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/reviews/get') {
      await detailRead.opened;
      return Response.json({ review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 1, needsDecision: 0 } }, human });
    }
    if (path === '/v1/reviews/comments') {
      await commentsRead.opened;
      return Response.json({ items: [accepted].map(storePlainReviewCommentFixture), cursor: null });
    }
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Loading primary', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Loading primary' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const newRound = t('reviewWalkthrough.detail.newRound');
  const primary = () => screen.findAllByType(ReviewDetailView)[0]?.props.primaryAction ?? null;
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  try {
    // Neither the person's state nor the findings are known: nothing is offered, least of all New round.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(primary()?.title ?? null).not.toBe(newRound);
    expect(primary()?.onPress ? primary()?.disabled === true || primary()?.loading === true : true).toBe(true);
    // The person is known, the findings are not: no primary yet, and no grey placeholder held for one (U8 R5 B6).
    await act(async () => { detailRead.open(); });
    await vi.waitFor(() => expect(screen.findAllByType(ReviewDetailView)).toHaveLength(1));
    expect(primary()).toBeNull();
    // Both known: the real primary takes the same slot.
    await act(async () => { commentsRead.open(); });
    await vi.waitFor(() => expect(primary()?.title).toBe(t('runPage.review.implementFixes', { count: 1 })));
    expect(primary()?.loading ?? false).toBe(false);
  } finally { await screen.unmount(); }
});

it('stands on the Review record while its owner read loads, then brings People, the tabs and the findings in as one block (G2)', async () => {
  const reviewId = 'steady-tabs-review';
  // One person was asked: their People row is the owner's data and arrives with the read.
  const human: ReviewHumanStateV1 = { reviewId, roundOrdinal: 1, verdicts: [],
    requests: [{ id: 'steady-bob', roundOrdinal: 1, principal: { kind: 'account', accountId: 'bob' }, required: true, needsAccess: false }],
    needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false, requestedVerdict: false,
      pendingDecisions: false, canSubmitVerdict: false } };
  let openDetail!: () => void;
  const detailOpened = new Promise<void>(resolve => { openDetail = resolve; });
  fixture = await createSessionFilesViewFixture({ serverUrl: 'https://steady-tabs-review.test', request: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/reviews/get') {
      await detailOpened;
      return Response.json({ review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 } }, human });
    }
    if (path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
    return Response.json({}, { status: 404 });
  } });
  // One round, two scored reviewers: the round section and the score line come from the Review record itself.
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Steady tabs', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Steady tabs' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
      reviewerIds: ['steady-reviewer-1', 'steady-reviewer-2'], runs: [], reviewerQuality: [
        { reviewerId: 'steady-reviewer-1', displayName: 'Codex', score: 4, rationale: 'Clean.' },
        { reviewerId: 'steady-reviewer-2', score: 2, rationale: 'Untested.' }] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  const { t } = await import('@/text');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  // What the record draws, in order, above the block that waits for the read: it must not change when the read lands.
  const fromRecord = () => [
    screen.findHostByTestId('review-detail:header') ? 'header' : null,
    screen.findHostByTestId('review-detail:glance') || screen.findHostByTestId('review-detail:glance:pending') ? 'glance' : null,
    screen.findHostByTestId('review-detail:quality') ? 'quality' : null,
    screen.findHostByTestId('review-detail:group:reviewers') ? 'reviewers' : null,
  ].filter(Boolean);
  const block = () => ({ people: screen.findHostByTestId('review-detail:group:people') !== null,
    tabs: screen.findHostByTestId('review-detail:tab:findings') !== null,
    findings: screen.findHostByTestId('review-detail:panel:findings') !== null });
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const loading = fromRecord();
    expect(loading).toEqual(['header', 'glance', 'quality', 'reviewers']);
    // Held open: nothing that could move under the person is on screen yet.
    expect(block()).toEqual({ people: false, tabs: false, findings: false });
    expect(screen.findAllByType(ReviewDetailView)[0]?.props.primaryAction?.title ?? null).not.toBe(t('reviewWalkthrough.detail.newRound'));
    await act(async () => { openDetail(); });
    await vi.waitFor(() => expect(screen.findHostByTestId('review-detail:glance')).not.toBeNull());
    expect(block()).toEqual({ people: true, tabs: true, findings: true });
    expect(fromRecord()).toEqual(loading);
  } finally { await screen.unmount(); }
});

it.each(['cold', 'warm'] as const)('keeps "…" on the header\'s trailing edge before and after the primary arrives, with the primary to its left (G4, %s)', async open => {
  const reviewId = `trailing-more-${open}`;
  const human: ReviewHumanStateV1 = { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
    needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: true, requestedVerdict: true,
      pendingDecisions: false, canSubmitVerdict: true } };
  let openDetail!: () => void;
  const detailOpened = open === 'warm' ? Promise.resolve() : new Promise<void>(resolve => { openDetail = resolve; });
  fixture = await createSessionFilesViewFixture({ serverUrl: `https://trailing-more-${open}.test`, request: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/reviews/get') {
      await detailOpened;
      return Response.json({ review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 } }, human });
    }
    if (path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
    return Response.json({}, { status: 404 });
  } });
  const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId, title: 'Trailing more', isDecrypted: true,
    header: { kind: 'review.v1', v: 1, reviewId, title: 'Trailing more' },
    body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
    ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  fixture.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(artifact, 'alice'));
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  const { t } = await import('@/text');
  const submit = t('reviewWalkthrough.detail.submitReview');
  const screen = await fixture.render(<ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} />);
  // The header's controls in drawing order: "…" must be the last one, whatever stands before it.
  const headerControls = () => {
    const header = JSON.stringify(screen.findHostByTestId('review-detail:header') ? screen.tree.toJSON() : null);
    const more = header.indexOf('"review-detail:more"');
    const primary = header.indexOf(`"accessibilityLabel":${JSON.stringify(submit)}`);
    return { more: more >= 0, primary: primary >= 0, moreTrailing: more >= 0 && (primary < 0 || more > primary) };
  };
  try {
    if (open === 'cold') {
      await vi.waitFor(() => expect(screen.findHostByTestId('review-detail:more')).not.toBeNull());
      expect(headerControls()).toEqual({ more: true, primary: false, moreTrailing: true });
      await act(async () => { openDetail(); });
    }
    await vi.waitFor(() => expect(headerControls().primary).toBe(true));
    expect(headerControls()).toEqual({ more: true, primary: true, moreTrailing: true });
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
