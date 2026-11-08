import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { DocPassageMarginThread } from './docPassageMargin';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock().module;
});

const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactPassageThreadCard } = await import('./ArtifactPassageThreadCard');

afterEach(() => standardCleanup());

const ref = { kind: 'doc' as const, artifactId: 'runbook', serverId: 'home' };
const firstQuote = 'Up to 5 tries';
const firstPassage: DocPassageRefV1 = { ref, revision: { headerVersion: 1, bodyVersion: 2 }, range: { start: 0, end: firstQuote.length }, quote: firstQuote };
const laterPassage: DocPassageRefV1 = { ref, revision: { headerVersion: 1, bodyVersion: 5 }, range: { start: 4, end: 20 }, quote: 'Up to 3 attempts' };
const root: DiscussionOpenedMessageV1 = {
  id: 'm1', discussionId: 'thread-1', seq: 1, authorAccountId: 'ben', accountActor: null, createdAt: 1,
  localId: null, mentionedAccountIds: [], producerV1: null,
  messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'thread-1' }, messageId: 'm1' },
  replyTarget: { kind: 'doc_passage', doc: { ref, revision: firstPassage.revision } },
  content: { kind: 'doc_passage_comment', passage: firstPassage, content: { v: 1, parts: [{ t: 'text', text: 'Still right?' }] } },
};
const thread = (
  location: DocPassageMarginThread['location'], passage: DocPassageRefV1 = firstPassage,
): DocPassageMarginThread<DiscussionOpenedMessageV1> => ({ discussionId: 'thread-1', passage, original: firstPassage, location, root,
  replies: [], proposal: null, acceptedProposal: null, suggestion: null });

async function mount(input: Readonly<{ thread: DocPassageMarginThread<DiscussionOpenedMessageV1>; attaching?: boolean }>) {
  const handlers = { onReattach: vi.fn(), onCancelReattach: vi.fn(), onOpenHistory: vi.fn() };
  const screen = await renderScreen(
    <ArtifactPassageThreadCard thread={input.thread} focused={false} attaching={input.attaching === true}
      client={createArtifactActionsClient({ serverId: 'home', accountId: 'alice' }, vi.fn() as never)}
      docRead={{ status: 'loading' }} mountThread={() => () => {}} viewerAccountId="alice"
      onFocus={() => {}} onOpen={() => {}} {...handlers} />,
  );
  return { screen, ...handlers };
}
const id = 'artifact:passage-thread:thread-1';

describe('ArtifactPassageThreadCard re-attachment', () => {
  it('offers the originating Doc thread the same in-place review for its agent edit proposal as the Session', async () => {
    const previousState = storage.getState();
    const { Modal } = await import('@/modal');
    vi.spyOn(Modal, 'show').mockReturnValue('doc-proposal-review');
    try {
      const approval = buildDiscussionRequesterApprovalArtifact({ serverId: 'home', discussionId: 'thread-1',
        originMessageId: root.id, requesterAccountId: 'alice', actionId: 'doc.edit.propose' });
      await act(async () => storage.setState({ isDataReady: true }));
      const view = await mount({ thread: thread({ state: 'exact', range: firstPassage.range }) });
      expect(view.screen.findByTestId('session-discussion-waiting-approval-review')).toBeNull();
      await act(async () => storage.getState().applyArtifacts([approval]));
      await view.screen.pressByTestIdAsync('session-discussion-waiting-approval-review');
      expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
        props: expect.objectContaining({ artifactId: approval.id, serverId: 'home' }),
      }));
    } finally {
      await act(async () => storage.setState(previousState));
    }
  });

  it('keeps the same person avatar identity in the Doc root and latest reply as in the Discussion', async () => {
    const source = thread({ state: 'exact', range: firstPassage.range });
    const actor = { v: 1 as const, accountId: 'ben', profile: { name: 'Ben', avatarUrl: null } };
    const message = { ...root, accountActor: actor };
    const view = await mount({ thread: { ...source, root: message, replies: [{ ...message, id: 'reply', seq: 2 }] } });
    const expected = resolveAccountActorPresentation({ ...actor, serverId: 'home' }, { serverId: 'home', accountId: 'alice' }).avatar;
    expect(view.screen.findAllByType(Avatar).map(node => node.props.id)).toEqual([expected.id, expected.id]);
  });

  it('renders typed Discussion mentions through the shared chips beside the Doc passage', async () => {
    const source = thread({ state: 'exact', range: { start: 0, end: 11 } });
    const view = await mount({ thread: { ...source, root: { ...source.root, content: {
      v: 1,
      parts: [
        { t: 'text', text: 'Ask ' },
        { t: 'mention', participant: { kind: 'account', accountId: 'alice' } },
        { t: 'text', text: ' about this passage' },
      ],
    } } } });
    const run = view.screen.findAllByType('EnrichedMarkdownText')[0];
    expect(run?.props.markdown).toBe('Ask [artifacts.browser.passage.you](happier-ref:account:alice) about this passage');
    expect(run?.props.selectable).toBe(true);
  });

  it('renders a message without mentions as Markdown too, so an answer keeps its emphasis and code blocks', async () => {
    const source = thread({ state: 'exact', range: { start: 0, end: 11 } });
    const markdown = '1. **Choose names** that describe intent.\n\n```ts\nconst activeUsers = users.filter(isActive);\n```';
    const view = await mount({ thread: { ...source, root: { ...source.root, content: { v: 1, parts: [{ t: 'text', text: markdown }] } } } });
    const runs = view.screen.findAllByType('EnrichedMarkdownText');
    expect(runs[0]?.props.markdown).toBe('1. **Choose names** that describe intent.');
    expect(view.screen.getTextContent()).toContain('const activeUsers = users.filter(isActive);');
    expect(view.screen.getTextContent()).not.toContain('```');
  });

  it('keeps a sent Session mention named beside its Doc passage even before that Session answers', async () => {
    const previousState = storage.getState();
    try {
      const session = createSessionFixture({ id: 'runbook-agent', serverId: 'home', metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView: { name: 'Support runbook', host: 'box', path: '/runbook' } });
      await act(async () => storage.setState({ sessionListRowsByServerId: { home: { 'runbook-agent': buildSessionListRenderableFromSession(session) } } }));
      const source = thread({ state: 'exact', range: firstPassage.range });
      const view = await mount({ thread: { ...source, root: { ...source.root, content: {
        v: 1, parts: [{ t: 'text', text: 'Ask ' }, { t: 'mention', participant: { kind: 'session', sessionId: 'runbook-agent' } }],
      } } } });
      expect(view.screen.findAllByType('EnrichedMarkdownText')[0]?.props.markdown)
        .toBe('Ask [Support runbook](happier-ref:session:runbook-agent)');
    } finally {
      await act(async () => storage.setState(previousState));
    }
  });

  it('offers to attach a changed passage to new text, beside its revision, and asks for the selection while attaching', async () => {
    const view = await mount({ thread: thread({ state: 'detached' }) });
    expect(view.screen.findByTestId(`${id}.compare`)).not.toBeNull();
    await act(async () => view.screen.findByTestId(`${id}.reattach`)!.props.onPress());
    expect(view.onReattach).toHaveBeenCalledOnce();
    const attaching = await mount({ thread: thread({ state: 'detached' }), attaching: true });
    expect(attaching.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(attaching.screen.findByTestId(`${id}.reattaching`)).not.toBeNull();
    await act(async () => attaching.screen.findByTestId(`${id}.reattach-cancel`)!.props.onPress());
    expect(attaching.onCancelReattach).toHaveBeenCalledOnce();
  });

  it('offers nothing for a passage that is still placed and keeps the original quote and version of a re-attached thread', async () => {
    const placed = await mount({ thread: thread({ state: 'exact', range: { start: 0, end: 11 } }) });
    expect(placed.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(placed.screen.findByTestId(`${id}.earlier`)).toBeNull();
    const moved = await mount({ thread: thread({ state: 'exact', range: laterPassage.range }, laterPassage) });
    expect(moved.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(moved.screen.getTextContent()).toContain('Up to 3 attempts');
    expect(moved.screen.findByTestId(`${id}.earlier`)).not.toBeNull();
    expect(moved.screen.getTextContent()).toContain('Up to 5 tries');
  });

  it('names who suggested the edit on its card, since the margin shows the suggestion without its message byline', async () => {
    const source = thread({ state: 'exact', range: { start: 0, end: 11 } });
    const proposal: DiscussionOpenedMessageV1 = {
      ...root, id: 'm2', seq: 2, createdAt: 2,
      authorAccountId: 'mei', accountActor: { accountId: 'mei', profile: { name: 'Mei Kato' } } as DiscussionOpenedMessageV1['accountActor'],
      messageRef: { ...root.messageRef, messageId: 'm2' },
      replyTarget: { kind: 'message', messageId: 'm1' },
      content: { kind: 'doc_edit_proposal', proposal: {
        target: firstPassage, baseRevision: firstPassage.revision, before: firstPassage.quote, after: 'Up to 3 attempts', reason: 'Budget changed.',
      } },
    };
    const view = await mount({ thread: { ...source, replies: [proposal], proposal } });
    const card = view.screen.findByTestId(`${id}.proposal`);
    expect(card).not.toBeNull();
    const cardText = card!.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children).join(' ');
    expect(cardText).toContain('Mei Kato');
  });

  it('names an agent reply by its Session in the latest-reply line, not as the Account that runs it', async () => {
    const previousState = storage.getState();
    try {
      const agentSession = createSessionFixture({ id: 'runbook-agent', serverId: 'home', metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView: { name: 'Support runbook', host: 'box', path: '/runbook' } });
      await act(async () => {
        storage.setState({ sessionListRowsByServerId: { home: { 'runbook-agent': buildSessionListRenderableFromSession(agentSession) } } });
      });
      const source = thread({ state: 'exact', range: { start: 0, end: 11 } });
      const reply: DiscussionOpenedMessageV1 = {
        ...root, id: 'm2', seq: 2, createdAt: 2, authorAccountId: 'alice',
        producerV1: { kind: 'agent', sessionId: 'runbook-agent' } as DiscussionOpenedMessageV1['producerV1'],
        messageRef: { ...root.messageRef, messageId: 'm2' }, replyTarget: { kind: 'message', messageId: 'm1' },
        content: { v: 1, parts: [{ t: 'text', text: 'Updated.' }] },
      };
      const view = await mount({ thread: { ...source, replies: [reply] } });
      const line = view.screen.findByTestId(`${id}.reply`);
      const lineText = line!.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children).join(' ');
      expect(lineText).toContain('Support runbook');
    } finally {
      await act(async () => { storage.setState(previousState); });
    }
  });

  it('names an agent suggestion by its Session on the proposal card, not as the Account that runs it', async () => {
    const previousState = storage.getState();
    try {
      const agentSession = createSessionFixture({ id: 'runbook-agent', serverId: 'home', metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView: { name: 'Support runbook', host: 'box', path: '/runbook' } });
      await act(async () => {
        storage.setState({ sessionListRowsByServerId: { home: { 'runbook-agent': buildSessionListRenderableFromSession(agentSession) } } });
      });
      const source = thread({ state: 'exact', range: { start: 0, end: 11 } });
      const proposal: DiscussionOpenedMessageV1 = {
        ...root, id: 'm2', seq: 2, createdAt: 2, authorAccountId: 'alice',
        accountActor: { accountId: 'alice', profile: { name: 'QA owner' } } as DiscussionOpenedMessageV1['accountActor'],
        producerV1: { kind: 'agent', sessionId: 'runbook-agent' } as DiscussionOpenedMessageV1['producerV1'],
        messageRef: { ...root.messageRef, messageId: 'm2' }, replyTarget: { kind: 'message', messageId: 'm1' },
        content: { kind: 'doc_edit_proposal', proposal: {
          target: firstPassage, baseRevision: firstPassage.revision, before: firstPassage.quote,
          after: 'Up to 3 attempts', reason: 'Budget changed.',
        } },
      };
      const view = await mount({ thread: { ...source, replies: [proposal], proposal } });
      const card = view.screen.findByTestId(`${id}.proposal`);
      const cardText = card!.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children).join(' ');
      expect(cardText).toContain('Support runbook');
      expect(cardText).not.toContain('QA owner');
    } finally {
      await act(async () => { storage.setState(previousState); });
    }
  });
});
