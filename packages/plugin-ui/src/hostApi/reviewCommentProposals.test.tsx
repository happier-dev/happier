import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { createReviewCommentLinkedIssueIdV1 } from '@happier-dev/plugin-sdk/reviews';
import renderer from 'react-test-renderer';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PluginHostApiProvider } from '../advanced/index.js';
import {
  useReviewCommentProposalsForEntry,
  type ReviewCommentProposalReadV1,
} from './reviewCommentProposals.public.js';

const PROPOSAL = {
  id: 'comment-1',
  body: 'Use the canonical proposal reader.',
  snapshot: {
    kind: 'text',
    selectedLines: ['Use the canonical proposal reader.'],
    beforeContext: [],
    afterContext: [],
    selectedLinesHash: 'selected-lines',
    contextWindowHash: 'context-window',
    capturedAt: 1,
    fileLength: 1,
    source: 'committed',
    isUncommitted: false,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
  },
  linkedRefs: [{ kind: 'pullRequest', url: 'https://gitlab.com/group/project/-/merge_requests/42' }],
};
const ISSUE_ID = createReviewCommentLinkedIssueIdV1({
  source: { pluginId: 'happier.scm.gitlab', localId: 'gitlab' },
  kindId: 'issue',
  collisionScope: 'gitlab:group/project',
  entryId: '42',
});

describe('useReviewCommentProposalsForEntry', () => {
  it('pages every linked Session, filters the exact provider entry, and deduplicates canonical ids', async () => {
    const executeAction = vi.fn(async (_action: unknown, input: unknown) => {
      const request = input as Readonly<{ sessionId: string; cursor?: string }>;
      if (request.cursor === undefined) {
        return {
          items: [
            PROPOSAL,
            { ...PROPOSAL, id: `wrong-${request.sessionId}`, linkedRefs: [{ kind: 'issue', id: ISSUE_ID, url: 'https://gitlab.com/group/project/-/issues/42' }] },
          ],
          cursor: 'next-page',
        };
      }
      return { items: [PROPOSAL], cursor: null };
    });
    const hostApi = {
      executeAction,
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    const reads: ReviewCommentProposalReadV1[] = [];

    function Probe() {
      reads.push(useReviewCommentProposalsForEntry({
        linkedSessionIds: ['session-1', 'session-2'],
        entry: { kind: 'pullRequest', url: 'https://gitlab.com/group/project/-/merge_requests/42' },
      }));
      return null;
    }

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProvider hostApi={hostApi}>
          <Probe />
        </PluginHostApiProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(reads.at(-1)).toMatchObject({ status: 'ready', proposals: [{ id: 'comment-1' }] });
    });
    expect(executeAction).toHaveBeenCalledTimes(4);
    expect(executeAction).toHaveBeenCalledWith(
      'reviews.comments.list',
      expect.objectContaining({ sessionId: 'session-1', limit: 200 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    act(() => tree?.unmount());
  });

  it('publishes a failed state instead of retaining stale proposals after a failed replacement read', async () => {
    const hostApi = {
      executeAction: vi.fn(async () => { throw new Error('reviews unavailable'); }),
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    const reads: ReviewCommentProposalReadV1[] = [];
    function Probe() {
      reads.push(useReviewCommentProposalsForEntry({
        linkedSessionIds: ['session-1'],
        entry: { kind: 'pullRequest', url: 'https://gitlab.com/group/project/-/merge_requests/42' },
      }));
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<PluginHostApiProvider hostApi={hostApi}><Probe /></PluginHostApiProvider>);
    });
    await vi.waitFor(() => expect(reads.at(-1)).toEqual({ status: 'failed', proposals: [] }));
    act(() => tree?.unmount());
  });

  it('clears the prior entry proposals before a replacement entry read settles', async () => {
    let invocation = 0;
    const neverSettles = new Promise<never>(() => {});
    const hostApi = {
      executeAction: vi.fn(async () => {
        invocation += 1;
        if (invocation === 1) return { items: [PROPOSAL], cursor: null };
        return await neverSettles;
      }),
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    const reads: ReviewCommentProposalReadV1[] = [];
    function Probe({ entryUrl }: Readonly<{ entryUrl: string }>) {
      reads.push(useReviewCommentProposalsForEntry({
        linkedSessionIds: ['session-1'],
        entry: { kind: 'pullRequest', url: entryUrl },
      }));
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProvider hostApi={hostApi}>
          <Probe entryUrl="https://gitlab.com/group/project/-/merge_requests/42" />
        </PluginHostApiProvider>,
      );
    });
    await vi.waitFor(() => expect(reads.at(-1)?.status).toBe('ready'));

    act(() => {
      tree.update(
        <PluginHostApiProvider hostApi={hostApi}>
          <Probe entryUrl="https://gitlab.com/group/project/-/merge_requests/43" />
        </PluginHostApiProvider>,
      );
    });
    expect(reads.at(-1)).toEqual({ status: 'loading', proposals: [] });
    act(() => tree.unmount());
  });

  it('matches an issue by its required opaque id rather than a mutable provider URL', async () => {
    const issueProposal = {
      ...PROPOSAL,
      linkedRefs: [{
        kind: 'issue',
        id: ISSUE_ID,
        url: 'https://gitlab.com/group/project/-/issues/renamed-location',
      }],
    };
    const hostApi = {
      executeAction: vi.fn(async () => ({ items: [issueProposal], cursor: null })),
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    const reads: ReviewCommentProposalReadV1[] = [];
    function Probe() {
      reads.push(useReviewCommentProposalsForEntry({
        linkedSessionIds: ['session-1'],
        entry: { kind: 'issue', id: ISSUE_ID },
      }));
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<PluginHostApiProvider hostApi={hostApi}><Probe /></PluginHostApiProvider>);
    });
    await vi.waitFor(() => {
      expect(reads.at(-1)).toMatchObject({ status: 'ready', proposals: [{ id: 'comment-1' }] });
    });
    act(() => tree?.unmount());
  });

  it('does not scan Sessions when a pull-request projection has no exact URL identity', async () => {
    const executeAction = vi.fn();
    const hostApi = {
      executeAction,
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    const reads: ReviewCommentProposalReadV1[] = [];
    function Probe() {
      reads.push(useReviewCommentProposalsForEntry({
        linkedSessionIds: ['session-1'],
        entry: { kind: 'pullRequest' },
      }));
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<PluginHostApiProvider hostApi={hostApi}><Probe /></PluginHostApiProvider>);
    });
    await vi.waitFor(() => expect(reads.at(-1)).toEqual({ status: 'ready', proposals: [] }));
    expect(executeAction).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });
});
