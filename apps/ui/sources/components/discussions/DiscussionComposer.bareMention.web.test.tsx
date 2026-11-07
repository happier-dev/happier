/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionOwnerViewerFixture, flushHookEffects } from '@/dev/testkit';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { t } from '@/text';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The DOM editor, AgentInput's suggestion pipeline and the Discussion's candidate adapter stay real; only native
// rendering adapters, the Home transport and the Discussion roster HTTP read are replaced.
vi.mock(
  '@/components/ui/forms/MultiTextInput',
  async () => import('@/components/ui/forms/MultiTextInput.web'),
);
installAgentInputCommonModuleMocks({
  reactNative: async () => vi.importActual('react-native-web'),
});
vi.doMock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const mock = createReanimatedModuleMock();
  const rn =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
  return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const { installSessionPaneRuntimeTestHarness } =
  await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const candidateReads: string[] = [];
let failPeopleCandidates = false;
// An ordinary Session of this Account that nobody invited.
const runtime = installSessionPaneRuntimeTestHarness({
  sessionId: 'outsider-session',
  request: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/user/search') {
      candidateReads.push(path);
      if (failPeopleCandidates) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ users: [{ id: 'account-b', name: 'Doc reader', firstName: 'Doc', lastName: 'reader',
      username: 'reader', avatar: null, bio: null, badges: [], status: 'none', publicKey: null }], nextCursor: null });
    }
    if (path === '/v2/sessions/query') {
      candidateReads.push(path);
      return Response.json({ sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: 'outsider-session' }),
        viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: 'outsider-session' })) }],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
    }
    if (path.endsWith('/participants')) return Response.json({ discussionId: 'discussion-1', ownerAccountId: 'account-a', access: 'owner', grants: [], participants: [] });
    return undefined;
  },
});
const { DiscussionComposer } = await import('./DiscussionComposer');
const { storage } = await import('@/sync/domains/state/storage');
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  failPeopleCandidates = false;
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

// A passage draft has no preselected invitees. Its people and executable Session candidates come from
// the same public Discussion candidate Action as an existing Discussion, without a local Recent fallback.
it.each(['new', 'existing', 'retry'] as const)(
  'a bare @ in a %s Doc Discussion offers people and an own Session before it is invited',
  async (kind) => {
    candidateReads.length = 0;
    failPeopleCandidates = kind === 'retry';
    const serverId = runtime.serverId;
    const outsider = storage.getState().sessions['outsider-session'];
    if (!outsider) throw new Error('Expected the outsider Session');
    storage
      .getState()
      .applySessions([
        {
          ...outsider,
          active: true,
          metadata: {
            ...outsider.metadata!,
            summary: { text: 'Outsider work', updatedAt: 2 },
          },
        },
        createSessionFixture({
          id: 'invited-bot',
          serverId,
          active: true,
          metadata: {
            path: '/review',
            host: 'review-machine',
            summary: { text: 'Invited reviewer', updatedAt: 1 },
          },
        }),
      ]);
    const roster = DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1',
        ownerAccountId: 'account-a',
        access: 'owner',
        grants: [],
        participants: [
          {
            participant: { kind: 'session', sessionId: 'invited-bot' },
            answerPolicy: 'when_addressed',
            createdAt: 1,
          },
        ],
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const scope = runtime.accountScope!;
    const lifetime = {
      scope,
      isCurrent: () => true,
      onRetire: () => ({ dispose: () => undefined }),
    };
    function Host() {
      const [value, setValue] = React.useState({
        text: '',
        mentions: [] as never[],
      });
      return (
        <DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }}
          scope={scope}
          accountLifetime={lifetime}
          address={{ serverId }}
          {...(kind === 'existing'
            ? { discussionId: 'discussion-1', roster }
            : {})}
          availability="available"
          value={value}
          onChange={(next) => setValue(next as never)}
          disabled={false}
          onSend={() => undefined}
        />
      );
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <runtime.Wrapper>
          <Host />
        </runtime.Wrapper>,
      );
    });
    const editor = container.querySelector<HTMLElement>(
      '[data-happier-text-input]',
    )!;
    expect(editor).toBeTruthy();
    expect(candidateReads).toEqual([]);
    await act(async () => {
      editor.focus();
      const selection = window.getSelection()!;
      const text = document.createTextNode('@');
      selection.getRangeAt(0).insertNode(text);
      selection.collapse(text, text.length);
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: '@',
        }),
      );
    });
    await flushHookEffects();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Outsider work'),
    );
    if (kind === 'retry') {
      await vi.waitFor(() => expect(document.body.textContent).toContain(t('session.collaboration.discussion.retry')));
      failPeopleCandidates = false;
      const retry = [...document.querySelectorAll<HTMLElement>('div, span')]
        .find(element => element.childElementCount === 0
          && element.textContent === t('session.collaboration.discussion.retry'));
      expect(retry).toBeTruthy();
      await act(async () => { retry!.click(); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Doc reader'));
    }
    expect(document.body.textContent).toContain('Doc reader');
  },
);
