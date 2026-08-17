import { describe, expect, it } from 'vitest';

import {
  classifyGithubIssueCommentPage,
  createGithubIssueCommentSince,
  parseGithubIssueCommentCursor,
  type GithubIssueCommentCursorV1,
} from './githubIssueCommentCursor.js';

const initialCursor: GithubIssueCommentCursorV1 = {
  v: 1,
  updatedAtIso: '2026-08-10T12:00:00.000Z',
  commentIdAtUpdatedAt: '8',
  etag: null,
};

describe('GitHub issue-comment checkpoint', () => {
  it('reads released V1 checkpoints without a continuation as a completed pull window', () => {
    expect(parseGithubIssueCommentCursor({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '8',
      etag: 'released-etag',
    })).toMatchObject({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '8',
      etag: 'released-etag',
      continuation: null,
    });
  });

  it('clears a stale continuation and its ETag when the checkpoint changes transport', () => {
    expect(parseGithubIssueCommentCursor({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '8',
      etag: 'stale-poll-etag',
      continuation: {
        transport: 'webhook',
        connectionId: 'connection-1',
        providerConnectionKey: 'github:repository:77',
        filterSince: '2026-08-10T11:59:59Z',
        url: 'https://api.github.com/repos/acme/widgets/issues/comments?sort=updated&direction=asc&since=2026-08-10T11%3A59%3A59Z&per_page=100&page=11',
      },
    })).toMatchObject({
      etag: null,
      continuation: null,
    });
  });

  it('overlaps the second-granular since boundary and keeps equal-timestamp comments across pages', () => {
    expect(createGithubIssueCommentSince(initialCursor)).toBe('2026-08-10T11:59:59Z');

    const firstPage = classifyGithubIssueCommentPage({
      cursor: initialCursor,
      comments: [{
        commentId: '9',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:00Z',
      }],
    });
    expect(firstPage.classifications).toEqual([{ kind: 'admit', commentId: '9' }]);

    const secondPage = classifyGithubIssueCommentPage({
      cursor: firstPage.cursor,
      comments: [{
        commentId: '10',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:00Z',
      }],
    });
    expect(secondPage.classifications).toEqual([{ kind: 'admit', commentId: '10' }]);
    expect(secondPage.cursor).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '10',
    });

    const replay = classifyGithubIssueCommentPage({
      cursor: secondPage.cursor,
      comments: [{
        commentId: '9',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:00Z',
      }, {
        commentId: '10',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:00Z',
      }],
    });
    expect(replay.classifications).toEqual([
      { kind: 'alreadyClassified', commentId: '9' },
      { kind: 'alreadyClassified', commentId: '10' },
    ]);
  });

  it('classifies edits as terminal unsupported work while still advancing the checkpoint', () => {
    const result = classifyGithubIssueCommentPage({
      cursor: initialCursor,
      comments: [{
        commentId: '900719925474099312345',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:01Z',
      }],
    });

    expect(result.classifications).toEqual([
      { kind: 'unsupportedEdit', commentId: '900719925474099312345' },
    ]);
    expect(result.cursor).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:01.000Z',
      commentIdAtUpdatedAt: '900719925474099312345',
    });
  });

  it('never advances the checkpoint beyond a total terminal-item batch limit', () => {
    const result = classifyGithubIssueCommentPage({
      cursor: initialCursor,
      maxTerminalItems: 1,
      comments: [{
        commentId: '9',
        createdAtIso: '2026-08-10T12:00:01Z',
        updatedAtIso: '2026-08-10T12:00:02Z',
      }, {
        commentId: '10',
        createdAtIso: '2026-08-10T12:00:03Z',
        updatedAtIso: '2026-08-10T12:00:03Z',
      }],
    });

    expect(result.classifications).toEqual([{ kind: 'unsupportedEdit', commentId: '9' }]);
    expect(result.cursor).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:02.000Z',
      commentIdAtUpdatedAt: '9',
    });
  });

  it('reserves the zero lower bound for the cursor and never accepts it as a GitHub comment ID', () => {
    expect(() => classifyGithubIssueCommentPage({
      cursor: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '0',
        etag: null,
      },
      comments: [{
        commentId: '0',
        createdAtIso: '2026-08-10T12:00:00Z',
        updatedAtIso: '2026-08-10T12:00:00Z',
      }],
    })).toThrow(/positive decimal/u);
  });
});
