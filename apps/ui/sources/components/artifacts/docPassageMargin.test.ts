import { describe, expect, it } from 'vitest';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import {
  buildDocPassageMargin,
  readDocPassageThreadQuote,
  type DocPassageMarginMessage,
} from './docPassageMargin';

const ref = { kind: 'doc' as const, artifactId: 'doc-1', serverId: 'home-1' };
const r1 = { headerVersion: 1, bodyVersion: 1 };
const r2 = { headerVersion: 1, bodyVersion: 2 };
const source1 =
  'Check the dashboard. A replay shows two rows. Escalate to on-call.';

function passage(
  source: string,
  quote: string,
  revision = r1,
): DocPassageRefV1 {
  const start = source.indexOf(quote);
  return { ref, revision, range: { start, end: start + quote.length }, quote };
}

let seq = 0;
function comment(
  discussionId: string,
  target: DocPassageRefV1,
  text = 'Is this right?',
): DocPassageMarginMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    discussionId,
    seq: 1,
    authorAccountId: 'ben',
    createdAt: seq,
    replyTarget: {
      kind: 'doc_passage',
      doc: { ref, revision: target.revision },
    },
    content: {
      kind: 'doc_passage_comment',
      passage: target,
      content: { v: 1, parts: [{ t: 'text', text }] },
    },
  };
}

function proposal(
  discussionId: string,
  target: DocPassageRefV1,
  after: string,
  disposition: DocPassageMarginMessage['docEditProposalDispositionV1'],
): DocPassageMarginMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    discussionId,
    seq: 2,
    authorAccountId: 'agent-owner',
    createdAt: seq,
    replyTarget: { kind: 'message', messageId: 'root' },
    content: {
      kind: 'doc_edit_proposal',
      proposal: {
        target,
        baseRevision: target.revision,
        before: target.quote,
        after,
        reason: 'Replays changed.',
      },
    },
    docEditProposalDispositionV1: disposition,
  };
}

describe('buildDocPassageMargin', () => {
  it('names an open suggestion for the body only while the Doc is still at the revision it was based on', () => {
    const replay = passage(source1, 'A replay shows two rows.');
    const after = 'A replay shows one row.';
    const threads = [{ discussionId: 'd-replay', messages: [comment('d-replay', replay), proposal('d-replay', replay, after, undefined)] }];
    const current = buildDocPassageMargin({ source: source1, revision: r1, threads });
    expect(current.threads[0]?.suggestion).toEqual({ range: replay.range, after });

    const movedOn = buildDocPassageMargin({ source: `${source1} More.`, revision: r2, threads });
    expect(movedOn.threads[0]?.suggestion).toBeNull();

    const declined = buildDocPassageMargin({ source: source1, revision: r1, threads: [{ discussionId: 'd-replay', messages: [
      comment('d-replay', replay),
      proposal('d-replay', replay, after, { state: 'declined', decidedBy: { accountId: 'you', atMs: 1 } }),
    ] }] });
    expect(declined.threads[0]?.suggestion).toBeNull();
  });

  it('orders threads by where their passage sits and keeps an unplaceable passage, last, as changed', () => {
    const replay = passage(source1, 'A replay shows two rows.');
    const check = passage(source1, 'Check the dashboard.');
    const gone = passage(source1, 'Escalate to on-call.');
    const source2 = source1.replace(
      'Escalate to on-call.',
      'Escalate to payments on-call.',
    );
    const margin = buildDocPassageMargin({
      source: source2,
      revision: r2,
      threads: [
        { discussionId: 'd-gone', messages: [comment('d-gone', gone)] },
        { discussionId: 'd-replay', messages: [comment('d-replay', replay)] },
        { discussionId: 'd-check', messages: [comment('d-check', check)] },
      ],
    });
    expect(
      margin.threads.map((thread) => [
        thread.discussionId,
        thread.location.state,
      ]),
    ).toEqual([
      ['d-check', 'relocated'],
      ['d-replay', 'relocated'],
      ['d-gone', 'detached'],
    ]);
  });

  it('keeps accepted text placed after unrelated edits without changing its acceptance revision', () => {
    const replay = passage(source1, 'A replay shows two rows.');
    const after = 'A replay shows one row with a replayed badge.';
    const source2 = source1.replace('A replay shows two rows.', after);
    const accepted = {
      state: 'accepted' as const,
      acceptedRevision: r2,
      decidedBy: { accountId: 'you', atMs: 500 },
    };
    const threads = [
      {
        discussionId: 'd-replay',
        messages: [
          comment('d-replay', replay),
          proposal('d-replay', replay, after, accepted),
        ],
      },
    ];

    const current = buildDocPassageMargin({
      source: source2,
      revision: r2,
      threads,
    });
    expect(current.threads[0]!.location).toEqual({
      state: 'revised',
      range: {
        start: source2.indexOf(after),
        end: source2.indexOf(after) + after.length,
      },
    });
    expect(current.threads[0]!.proposal?.id).toBe(threads[0]!.messages[1]!.id);
    expect(current.accepted).toEqual({
      deciderAccountId: 'you',
      proposerAccountId: 'agent-owner',
      atMs: 500,
      revision: r2,
    });

    for (const source of [`${source2} More.`, `Introduction. ${source2}`]) {
      const later = buildDocPassageMargin({
        source,
        revision: { headerVersion: 1, bodyVersion: 3 },
        threads,
      });
      expect(later.threads[0]!.location).toEqual({
        state: 'revised',
        range: { start: source.indexOf(after), end: source.indexOf(after) + after.length },
      });
      expect(readDocPassageThreadQuote(later.threads[0]!)).toBe(after);
      expect(later.accepted).toEqual(current.accepted);
    }
    // Later revisions use the same unambiguous relocation rule as original quotes.
    const ambiguous = buildDocPassageMargin({ source: `${source2} ${after}`,
      revision: { headerVersion: 1, bodyVersion: 3 }, threads });
    expect(ambiguous.threads[0]!.location.state).toBe('detached');
    const earlier = buildDocPassageMargin({ source: source2, revision: r1, threads });
    expect(earlier.threads[0]!.location.state).toBe('detached');
  });

  it('reads the accepted edit from the proposal accepted into this revision while a later proposal stays open', () => {
    const replay = passage(source1, 'A replay shows two rows.');
    const after = 'A replay shows one row with a replayed badge.';
    const source2 = source1.replace('A replay shows two rows.', after);
    const accepted = proposal('d-replay', replay, after, {
      state: 'accepted',
      acceptedRevision: r2,
      decidedBy: { accountId: 'you', atMs: 500 },
    });
    // A second suggestion on the same words, written against the first revision and still open.
    const openLater = {
      ...proposal('d-replay', replay, 'A replay shows three rows.', { state: 'open' }),
      seq: 3,
    };
    const margin = buildDocPassageMargin({
      source: source2,
      revision: r2,
      threads: [
        { discussionId: 'd-replay', messages: [comment('d-replay', replay), accepted, openLater] },
      ],
    });
    const thread = margin.threads[0]!;
    expect(thread.location.state).toBe('revised');
    expect(margin.accepted).toMatchObject({ atMs: 500, revision: r2 });
    // The card keeps offering the open suggestion; the words as read now are the accepted ones.
    expect(thread.proposal?.id).toBe(openLater.id);
    expect(thread.acceptedProposal?.id).toBe(accepted.id);
    expect(readDocPassageThreadQuote(thread)).toBe(after);
  });

  it('keeps the accepted edit on the card when a later suggestion was declined', () => {
    const replay = passage(source1, 'A replay shows two rows.');
    const after = 'A replay shows one row with a replayed badge.';
    const source2 = source1.replace('A replay shows two rows.', after);
    const accepted = proposal('d-replay', replay, after, {
      state: 'accepted',
      acceptedRevision: r2,
      decidedBy: { accountId: 'you', atMs: 500 },
    });
    const declinedLater = {
      ...proposal('d-replay', replay, 'A replay shows three rows.', {
        state: 'declined',
        decidedBy: { accountId: 'you', atMs: 600 },
      }),
      seq: 3,
    };
    const thread = buildDocPassageMargin({
      source: source2,
      revision: r2,
      threads: [{ discussionId: 'd-replay', messages: [comment('d-replay', replay), accepted, declinedLater] }],
    }).threads[0]!;
    expect(thread.proposal?.id).toBe(accepted.id);
  });

  it('re-attaches a thread through a later comment basis and keeps the original passage', () => {
    const original = passage(source1, 'A replay shows two rows.');
    const source2 = 'Check the dashboard. A replay now shows one row. Escalate to on-call.';
    const reattached = passage(source2, 'A replay now shows one row.', r2);
    const root = comment('d-replay', original);
    const reply = { ...comment('d-replay', reattached, 'Moved to the reworded sentence.'), seq: 2 };
    const plain: DocPassageMarginMessage = { ...reply, id: 'plain', seq: 3, replyTarget: { kind: 'message', messageId: root.id },
      content: { v: 1, parts: [{ t: 'text', text: 'Thanks.' }] } };
    const detached = buildDocPassageMargin({ source: source2, revision: r2,
      threads: [{ discussionId: 'd-replay', messages: [root, plain] }] }).threads[0]!;
    expect(detached.location.state).toBe('detached');
    expect(detached.original).toEqual(original);
    const attached = buildDocPassageMargin({ source: source2, revision: r2,
      threads: [{ discussionId: 'd-replay', messages: [root, reply, plain,
        { ...reply, id: 'unreadable', seq: 4, content: null }] }] }).threads[0]!;
    expect(attached.location).toEqual({ state: 'exact', range: reattached.range });
    expect(attached.passage).toEqual(reattached);
    expect(attached.original).toEqual(original);
    expect(attached.root.id).toBe(root.id);
    expect(readDocPassageThreadQuote(attached)).toBe('A replay now shows one row.');
  });

  it('drops a thread whose root carries no readable passage', () => {
    const margin = buildDocPassageMargin({
      source: source1,
      revision: r1,
      threads: [
        {
          discussionId: 'd-locked',
          messages: [
            {
              id: 'x',
              discussionId: 'd-locked',
              seq: 1,
              authorAccountId: 'ben',
              createdAt: 1,
              content: null,
              replyTarget: { kind: 'doc_passage', doc: { ref, revision: r1 } },
            },
          ],
        },
      ],
    });
    expect(margin.threads).toEqual([]);
    expect(margin.unreadable).toBe(1);
  });

  it('keeps a later attachment as the placement basis after an older edit was accepted', () => {
    const original = passage(source1, 'A replay shows two rows.');
    const after = 'A replay now shows one row.';
    const source2 = source1.replace(original.quote, after);
    const attached = passage(source2, 'Escalate to on-call.', r2);
    const messages = [comment('d-replay', original), proposal('d-replay', original, after, {
      state: 'accepted', acceptedRevision: r2, decidedBy: { accountId: 'you', atMs: 500 },
    }), { ...comment('d-replay', attached), seq: 3 }];
    const thread = buildDocPassageMargin({ source: `${source2} More.`,
      revision: { ...r2, bodyVersion: 3 }, threads: [{ discussionId: 'd-replay', messages }] }).threads[0]!;
    expect(thread.location).toEqual({ state: 'relocated', range: attached.range });
    expect(readDocPassageThreadQuote(thread)).toBe(attached.quote);
  });
});
