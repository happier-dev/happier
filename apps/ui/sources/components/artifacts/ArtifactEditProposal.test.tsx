import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocEditProposalV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

import { createRenderCommitCounter, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

const cardCounters = vi.hoisted(() => new Map<string, ReturnType<typeof createRenderCommitCounter>>());
const continuationMounts = vi.hoisted(() => ({ active: 0, total: 0 }));

// Count the real presentation boundary without replacing proposal behavior.
vi.mock('@happier-dev/plugin-ui/components', async (importOriginal) => {
  const original = await importOriginal<typeof import('@happier-dev/plugin-ui/components')>();
  const { useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
  function CountedDocEditProposal(props: React.ComponentProps<typeof original.HappierDocEditProposal>) {
    const id = props.testID ?? '';
    let counter = cardCounters.get(id);
    if (!counter) {
      counter = createRenderCommitCounter();
      cardCounters.set(id, counter);
    }
    useRenderCommitCounter(counter);
    return <original.HappierDocEditProposal {...props} />;
  }
  return { ...original, HappierDocEditProposal: CountedDocEditProposal };
});

// Preserve the complete continuation hook and observe only its mounted lifetime.
vi.mock('@/components/approvals/useActionApprovalContinuation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/approvals/useActionApprovalContinuation')>();
  return {
    ...original,
    useActionApprovalContinuation: (
      input: Parameters<typeof original.useActionApprovalContinuation>[0],
    ) => {
      React.useEffect(() => {
        continuationMounts.active += 1;
        continuationMounts.total += 1;
        return () => { continuationMounts.active -= 1; };
      }, []);
      return original.useActionApprovalContinuation(input);
    },
  };
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit');
  return createModalModuleMock().module;
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { t } = await import('@/text');
const { Modal } = await import('@/modal');
const { getSessionComposerDraftSnapshot, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');
const {
  admitDocEditOperation,
  docEditOperationKey,
  releaseDocEditOperation,
  resetDocEditOperationsForTests,
} = await import('./docEditOperation');
const initialProfileScope = getStorage().getState().profileScope;

afterEach(() => {
  standardCleanup();
  resetSessionDraftRepositoryForTests();
  resetDocEditOperationsForTests();
  getStorage().getState().deleteArtifact('runbook');
  getStorage().setState({ profileScope: initialProfileScope });
  navigation.push.mockClear();
  cardCounters.clear();
  continuationMounts.active = 0;
  continuationMounts.total = 0;
});

const scope = { serverId: 'home', accountId: 'alice' };
const base = { headerVersion: 3, bodyVersion: 14 };
const proposal: DocEditProposalV1 = {
  target: {
    ref: { kind: 'doc', serverId: 'home', artifactId: 'runbook' },
    revision: base,
    range: { start: 0, end: 10 },
    quote: 'Two rows.!',
  },
  baseRevision: base,
  before: 'Two rows.!',
  after: 'One row with a replayed badge.',
  reason: 'Replays are recorded once now.',
};
const proposalRef: DiscussionMessageRefV1 = {
  kind: 'discussion',
  discussion: { serverId: 'home', discussionId: 'd1' },
  messageId: 'm1',
};

type Call = Readonly<{ actionId: string; input: unknown }>;
/** The Actions front door is the transport boundary to the Home; everything above it is the real client. */
function frontDoor(answers: Record<string, (input: unknown) => unknown>) {
  const calls: Call[] = [];
  const execute = vi.fn(async (actionId: string, input: unknown) => {
    calls.push({ actionId, input });
    const answer = answers[actionId];
    return answer ? answer(input) : { ok: false, errorCode: 'unexpected' };
  });
  return {
    calls,
    client: createArtifactActionsClient(scope, execute as never),
  };
}
const docRead =
  (revision: { headerVersion: number; bodyVersion: number }, access: 'owner' | 'edit' | 'view' = 'owner') => () => ({
    ok: true,
    result: {
      ref: { kind: 'doc', serverId: 'home', artifactId: 'runbook' },
      openCommentCount: 1,
      artifact: {
        artifactId: 'runbook', ownerAccountId: 'alice', access, publicAudience: 'none', header: { title: 'Runbook' },
        seq: 1, createdAt: 1, updatedAt: 2, body: 'Two rows.! Rest.', revision,
      },
    },
  });

async function render(
  client: ReturnType<typeof frontDoor>['client'],
  disposition?: React.ComponentProps<
    typeof ArtifactEditProposal
  >['disposition'],
  proposer?: React.ComponentProps<typeof ArtifactEditProposal>['proposer'],
) {
  const screen = await renderScreen(
    <ArtifactEditProposal
      testID="proposal"
      client={client}
      proposalRef={proposalRef}
      proposal={proposal}
      disposition={disposition}
      viewerAccountId="alice"
      resolveAccountLabel={() => 'Ana'}
      proposer={proposer}
    />,
  );
  await flushHookEffects();
  return screen;
}

const storedDoc = (revision: { headerVersion: number; bodyVersion: number }) => ({
  id: 'runbook', title: 'Runbook', header: { title: 'Runbook' }, isDecrypted: true as const, body: 'Two rows.! Rest.',
  ...revision, seq: 1, createdAt: 1, updatedAt: 2, ownerAccountId: 'alice', access: 'owner' as const, storageMode: 'plain' as const,
});

const storedDocFor = (artifactId: string, revision: { headerVersion: number; bodyVersion: number }) => ({
  ...storedDoc(revision), id: artifactId, title: artifactId, header: { title: artifactId },
});

const admittedDocRead = (artifactId: string, revision: { headerVersion: number; bodyVersion: number }) => ({
  status: 'ready' as const,
  value: {
    ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId },
    openCommentCount: 1,
    artifact: {
      artifactId, ownerAccountId: scope.accountId, access: 'owner' as const, publicAudience: 'none' as const,
      header: { title: artifactId }, seq: 1, createdAt: 1, updatedAt: 2, body: 'Two rows.! Rest.', revision,
    },
  },
});

describe('ArtifactEditProposal', () => {
  it('keeps Doc revision, operation and settlement work local across multiple proposal and receipt cards', async () => {
    getStorage().setState({ profileScope: scope });
    const openA = { ...proposal, target: { ...proposal.target, ref: { ...proposal.target.ref, artifactId: 'doc-a' } } };
    const openB = { ...proposal, target: { ...proposal.target, ref: { ...proposal.target.ref, artifactId: 'doc-b' } } };
    const receiptRevision = { headerVersion: 3, bodyVersion: 15 };
    const receiptC = { ...proposal, target: { ...proposal.target, ref: { ...proposal.target.ref, artifactId: 'doc-c' } } };
    const refA = { ...proposalRef, messageId: 'proposal-a' };
    const refB = { ...proposalRef, messageId: 'proposal-b' };
    const refC = { ...proposalRef, messageId: 'proposal-c' };
    for (const row of [storedDocFor('doc-a', base), storedDocFor('doc-b', base), storedDocFor('doc-c', receiptRevision)]) {
      getStorage().getState().addArtifact(row);
    }
    const door = frontDoor({
      'doc.edit.decline': (input) => ({
        ok: true,
        result: {
          proposalRef: (input as { proposalRef: DiscussionMessageRefV1 }).proposalRef,
          docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'alice', atMs: 6 } },
        },
      }),
    });
    const screen = await renderScreen(
      <>
        <ArtifactEditProposal testID="proposal-a" client={door.client} proposalRef={refA} proposal={openA}
          docRead={admittedDocRead('doc-a', base)} disposition={{ state: 'open' }} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'} />
        <ArtifactEditProposal testID="proposal-b" client={door.client} proposalRef={refB} proposal={openB}
          docRead={admittedDocRead('doc-b', base)} disposition={{ state: 'open' }} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'} />
        <ArtifactEditProposal testID="proposal-c" client={door.client} proposalRef={refC} proposal={receiptC}
          docRead={admittedDocRead('doc-c', receiptRevision)} disposition={{ state: 'accepted', acceptedRevision: receiptRevision,
            decidedBy: { accountId: 'alice', atMs: 5 } }} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'} />
      </>,
    );
    await flushHookEffects();
    const counters = ['proposal-a', 'proposal-b', 'proposal-c'].map((id) => cardCounters.get(id)!);
    for (const counter of counters) counter.reset();

    await act(async () => {
      const state = getStorage().getState();
      getStorage().setState({ sessions: { ...state.sessions } });
    });
    expect(counters.map((counter) => counter.read().commits)).toEqual([0, 0, 0]);

    expect(screen.findByTestId('proposal-c.undo')).not.toBeNull();
    await act(async () => {
      getStorage().getState().updateArtifact(storedDocFor('doc-c', { headerVersion: 3, bodyVersion: 16 }));
    });
    expect(counters.map((counter) => counter.read().commits)).toEqual([0, 0, 1]);
    expect(screen.findByTestId('proposal-c.undo')).toBeNull();
    expect(screen.findByTestId('proposal-c.undoConflict')).not.toBeNull();
    for (const counter of counters) counter.reset();

    const operationKeyA = docEditOperationKey(scope, refA.messageId);
    await act(async () => { admitDocEditOperation(operationKeyA, 'decline'); });
    expect(counters[0]!.read().commits).toBe(1);
    expect(counters.slice(1).map((counter) => counter.read().commits)).toEqual([0, 0]);
    await act(async () => { releaseDocEditOperation(operationKeyA); });
    for (const counter of counters) counter.reset();

    await act(async () => {
      getStorage().getState().updateArtifact(storedDocFor('doc-b', { headerVersion: 3, bodyVersion: 16 }));
    });
    expect(counters.map((counter) => counter.read().commits)).toEqual([0, 1, 0]);
    for (const counter of counters) counter.reset();

    await act(async () => { await screen.pressByTestIdAsync('proposal-a.decline'); });
    await flushHookEffects();
    expect(counters[0]!.read().commits).toBeGreaterThan(0);
    expect(counters.slice(1).map((counter) => counter.read().commits)).toEqual([0, 0]);

    expect(continuationMounts.active).toBe(0);
    expect(continuationMounts.total).toBe(0);
  });

  it.each(['ready', 'loading', 'unavailable'] as const)(
    'never offers Accept for a version 2 proposal when the version 4 Doc read is %s',
    async (status) => {
      const revision2 = { headerVersion: 2, bodyVersion: 2 };
      const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 4 }) });
      const current = await door.client.readDoc({ ref: proposal.target.ref });
      if (!current.ok) throw new Error('Expected an admitted current Doc');
      const readsBefore = door.calls.length;
      const screen = await renderScreen(<ArtifactEditProposal
        testID="proposal" client={door.client} proposalRef={proposalRef}
        proposal={{ ...proposal, baseRevision: revision2, target: { ...proposal.target, revision: revision2 } }}
        docRead={status === 'ready' ? { status, value: current.value } : { status }}
        disposition={{ state: 'open' }} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'}
      />);
      await flushHookEffects();
      expect(screen.findByTestId('proposal.accept')).toBeNull();
      expect(screen.findByTestId('proposal.current')).toBeNull();
      expect(screen.findByTestId('proposal.decline')).not.toBeNull();
      if (status === 'ready') {
        expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
        expect(screen.findByTestId('proposal.compare')).not.toBeNull();
      }
      // Parent admission owns this read; unknown admission must not start another per-card request.
      expect(door.calls).toHaveLength(readsBefore);
    },
  );

  it('withholds Accept while a standalone current read is pending and after it fails', async () => {
    let failRead!: (value: { ok: false; errorCode: string }) => void;
    const pending = new Promise<{ ok: false; errorCode: string }>((resolve) => { failRead = resolve; });
    const door = frontDoor({ 'doc.read': () => pending });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    await act(async () => { failRead({ ok: false, errorCode: 'artifact_action_failed' }); });
    await flushHookEffects();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.current')).toBeNull();
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('follows the Doc to a newer revision: an open suggestion stops saying it is current and offers Decline, not Accept', async () => {
    // This cache row belongs to the same Home/Account as the captured proposal client.
    getStorage().setState({ profileScope: scope });
    getStorage().getState().addArtifact(storedDoc(base));
    let current = base;
    const door = frontDoor({
      'doc.read': () => docRead(current)(),
      'doc.edit.decline': () => ({
        ok: true,
        result: { proposalRef, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'alice', atMs: 6 } } },
      }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.current')).not.toBeNull();
    // Another suggestion on this Doc is accepted: the Doc's revision moves on.
    current = { headerVersion: 3, bodyVersion: 15 };
    await act(async () => { getStorage().getState().updateArtifact(storedDoc(current)); });
    await flushHookEffects();
    expect(screen.findByTestId('proposal.current')).toBeNull();
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.compare')).not.toBeNull();
    // A suggestion that can no longer apply can still be declined; that needs no Doc rewrite.
    await act(async () => { await screen.pressByTestIdAsync('proposal.decline'); });
    await flushHookEffects();
    expect(door.calls.find((call) => call.actionId === 'doc.edit.decline')?.input).toEqual({ proposalRef });
    expect(screen.findByTestId('proposal.declined')).not.toBeNull();
  });

  it('accepts the reviewed revision and shows the receipt at the revision the Home acknowledged', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({
        ok: true,
        result: {
          proposalRef,
          docEditProposalDispositionV1: {
            state: 'accepted',
            acceptedRevision: accepted,
            decidedBy: { accountId: 'alice', atMs: 5 },
          },
        },
      }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.current')).not.toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.accept');
    });
    await flushHookEffects();
    expect(
      door.calls.find((call) => call.actionId === 'doc.edit.accept')?.input,
    ).toEqual({ proposalRef, expectedRevision: base });
    const receipt = screen.findByTestId('proposal.accepted');
    expect(receipt).not.toBeNull();
    // The receipt names the acknowledged revision, not the reviewed one.
    expect(screen.getTextContent()).toContain('15');
    expect(screen.findByTestId('proposal.accept')).toBeNull();
  });

  it('on a phone, confirms the accepted version in the app notice with an Undo that restores it', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const { Dimensions } = await import('react-native');
    const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
    const window = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 } as never);
    try {
      const door = frontDoor({
        'doc.read': docRead(base),
        'doc.edit.accept': () => ({
          ok: true,
          result: { proposalRef, docEditProposalDispositionV1: {
            state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 } } },
        }),
        'artifact.revisions.restore': () => ({ ok: true, result: { artifactId: 'runbook', revision: { headerVersion: 3, bodyVersion: 16 } } }),
      });
      const screen = await render(door.client);
      await act(async () => {
        await screen.pressByTestIdAsync('proposal.accept');
      });
      await flushHookEffects();
      const notice = readPresentationNotice();
      expect(notice?.message).toContain('15');
      expect(notice?.undo).toBeDefined();
      await act(async () => {
        notice?.undo?.run();
      });
      await flushHookEffects();
      expect(door.calls.find((call) => call.actionId === 'artifact.revisions.restore')?.input)
        .toEqual({ artifactId: 'runbook', bodyVersion: base.bodyVersion, expectedRevision: accepted });
    } finally {
      window.mockRestore();
      retirePresentationNotice();
    }
  });

  it('says nothing was applied when the document moved on, and never offers Accept on a stale basis', async () => {
    const door = frontDoor({
      'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.compare')).not.toBeNull();
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('compares the reviewed version with the current Doc through History, not by opening the current Doc', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const screen = await render(door.client);
    await act(async () => { await screen.pressByTestIdAsync('proposal.compare'); });
    expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
      props: expect.objectContaining({ artifactId: 'runbook', compareFromBodyVersion: 14 }),
    }));
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('asks the author to redo only when pressed: an addressed reply to the suggestion waits in the same thread, unsent', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const address = { kind: 'discussion', discussionId: 'd1' } as const;
    const screen = await render(door.client, undefined, { label: 'Support runbook', mention: { sessionId: 'runbook-session' } });
    expect(getSessionComposerDraftSnapshot(scope, address)).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('proposal.askRedo'); });
    const draft = getSessionComposerDraftSnapshot(scope, address);
    const token = formatInlineReferenceTokenV1({ label: 'Support runbook', ref: 'session:runbook-session' });
    expect(draft?.composer.text.value).toContain(`${token} `);
    expect(draft?.composer.mentions.value).toEqual([{ kind: 'happier.session', ref: 'session:runbook-session',
      label: 'Support runbook', start: 0, end: token.length, tokenText: token }]);
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('messageId=m1'));
    // Nothing is posted for the person: only the Doc read ran.
    expect(door.calls.map((call) => call.actionId)).toEqual(['doc.read']);
    // The suggestion itself stays: Decline is still there.
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('prints the diff once: not on the card while the body paints a current suggestion, back on it once the Doc moved on', async () => {
    const mount = async (revision: { headerVersion: number; bodyVersion: number }) => {
      const door = frontDoor({ 'doc.read': docRead(revision) });
      const screen = await renderScreen(
        <ArtifactEditProposal testID="proposal" client={door.client} proposalRef={proposalRef} proposal={proposal}
          disposition={undefined} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'} diffInBody />,
      );
      await flushHookEffects();
      return screen;
    };
    const current = await mount(base);
    expect(current.findByTestId('proposal.accept')).not.toBeNull();
    expect(current.findAllHostsByTestId('proposal.diff')).toHaveLength(0);
    standardCleanup();
    const movedOn = await mount({ headerVersion: 3, bodyVersion: 16 });
    expect(movedOn.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(movedOn.findByTestId('proposal.diff')).not.toBeNull();
  });

  it('titles your own suggestion without naming you as its subject', async () => {
    const door = frontDoor({ 'doc.read': docRead(base) });
    const screen = await renderScreen(
      <ArtifactEditProposal testID="proposal" client={door.client} proposalRef={proposalRef} proposal={proposal}
        disposition={undefined} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'}
        proposer={{ label: 'You', mention: { accountId: 'alice' } }} namesProposer />,
    );
    await flushHookEffects();
    expect(screen.getTextContent()).toContain(t('artifacts.browser.proposal.title'));
    expect(screen.getTextContent()).not.toContain(t('artifacts.browser.proposal.titleBy', { who: 'You' }));
  });

  it('does not offer Ask to redo on a suggestion a later one in its thread already replaced', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const screen = await renderScreen(
      <ArtifactEditProposal testID="proposal" client={door.client} proposalRef={proposalRef} proposal={proposal}
        disposition={undefined} viewerAccountId="alice" resolveAccountLabel={() => 'Ana'}
        proposer={{ label: 'Support runbook', mention: { sessionId: 'runbook-session' } }} superseded />,
    );
    await flushHookEffects();
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.askRedo')).toBeNull();
    // It can still be declined; nothing about it is hidden.
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('never offers to ask yourself to redo your own suggestion', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const screen = await render(door.client, undefined, { label: 'You', mention: { accountId: 'alice' } });
    expect(screen.findByTestId('proposal.askRedo')).toBeNull();
  });

  it('turns a refused stale Accept into the moved-on state instead of a receipt', async () => {
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({ ok: false, errorCode: 'version_mismatch' }),
    });
    const screen = await render(door.client);
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.accept');
    });
    await flushHookEffects();
    expect(screen.findByTestId('proposal.accepted')).toBeNull();
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
  });

  it('undoes an accepted edit as a restore against the accepted revision, and refuses after a later edit', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(accepted),
      'artifact.revisions.restore': () => ({
        ok: false,
        errorCode: 'version_mismatch',
      }),
    });
    const screen = await render(door.client, {
      state: 'accepted',
      acceptedRevision: accepted,
      decidedBy: { accountId: 'alice', atMs: 5 },
    });
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.undo');
    });
    await flushHookEffects();
    expect(
      door.calls.find((call) => call.actionId === 'artifact.revisions.restore')
        ?.input,
    ).toEqual({
      artifactId: 'runbook',
      bodyVersion: 14,
      expectedRevision: accepted,
    });
    expect(screen.findByTestId('proposal.undoConflict')).not.toBeNull();
    expect(screen.findByTestId('proposal.accepted')).not.toBeNull();
  });

  it('leads a refused Undo to the Doc history sheet, where a version can be picked', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(accepted),
      'artifact.revisions.restore': () => ({ ok: false, errorCode: 'version_mismatch' }),
    });
    const screen = await render(door.client, {
      state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 },
    });
    await act(async () => { await screen.pressByTestIdAsync('proposal.undo'); });
    await flushHookEffects();
    vi.mocked(Modal.show).mockClear();
    await act(async () => { await screen.pressByTestIdAsync('proposal.undoConflict.open'); });
    expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
      props: expect.objectContaining({ artifactId: 'runbook' }),
    }));
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('mounts an accepted receipt whose Doc already moved on with its conflict line and no Undo', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({ 'doc.read': docRead(accepted) });
    getStorage().setState({ profileScope: scope });
    getStorage().getState().addArtifact(storedDoc({ headerVersion: 3, bodyVersion: 17 }));
    const screen = await render(door.client, { state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 } });
    expect(screen.findByTestId('proposal.accepted')).not.toBeNull();
    expect(screen.findByTestId('proposal.undo')).toBeNull();
    expect(screen.findByTestId('proposal.undoConflict')).not.toBeNull();
  });

  it('still offers Undo on an accepted receipt whose Doc is at the accepted revision', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({ 'doc.read': docRead(accepted) });
    getStorage().setState({ profileScope: scope });
    getStorage().getState().addArtifact(storedDoc(accepted));
    const screen = await render(door.client, { state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 } });
    expect(screen.findByTestId('proposal.undo')).not.toBeNull();
    expect(screen.findByTestId('proposal.undoConflict')).toBeNull();
  });

  it('shows an approval-gated Undo as waiting with a way to open the request, and never dispatches the restore twice', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(accepted),
      'artifact.revisions.restore': () => ({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'approval-9', actionId: 'artifact.revisions.restore' },
      }),
    });
    const screen = await render(door.client, {
      state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 },
    });
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.undo');
    });
    await flushHookEffects();
    // The receipt no longer offers Undo; the card says the restore waits for approval and leads to it.
    expect(screen.findByTestId('proposal.undo')).toBeNull();
    expect(screen.findByTestId('proposal.undoPending')).not.toBeNull();
    expect(screen.findByTestId('proposal.undone')).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.undoPending.open');
    });
    expect(navigation.push).toHaveBeenCalledWith('/inbox/approvals/approval-9?serverId=home');
    expect(door.calls.filter((call) => call.actionId === 'artifact.revisions.restore')).toHaveLength(1);
  });

  it('leads an approval-gated Accept to its request instead of returning silently', async () => {
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-3', actionId: 'doc.edit.accept' },
      }),
    });
    const screen = await render(door.client);
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.accept');
    });
    await flushHookEffects();
    expect(navigation.push).toHaveBeenCalledWith('/inbox/approvals/approval-3?serverId=home');
    expect(screen.findByTestId('proposal.accepted')).toBeNull();
  });

  it('says who can accept instead of offering Accept to someone who can only read the document', async () => {
    const door = frontDoor({ 'doc.read': docRead(base, 'view') });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.cantEdit')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
  });

  it('shows a declined proposal as settled with no decision controls', async () => {
    const door = frontDoor({ 'doc.read': docRead(base) });
    const screen = await render(door.client, {
      state: 'declined',
      decidedBy: { accountId: 'bob', atMs: 5 },
    });
    expect(screen.findByTestId('proposal.declined')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.decline')).toBeNull();
  });
});
