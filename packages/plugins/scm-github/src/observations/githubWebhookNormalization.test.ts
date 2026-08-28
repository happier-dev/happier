import { describe, expect, it, vi } from 'vitest';

import {
  normalizeGithubWebhookDelivery,
} from './githubWebhookNormalization.js';

const issueCommentPayload = {
  action: 'created',
  repository: { id: 77, full_name: 'acme/widgets' },
  issue: { id: 300, number: 12, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/12' } },
  comment: {
    id: 444,
    body: '@happier-bot Please investigate this failure.',
    created_at: '2026-08-10T12:00:00Z',
    updated_at: '2026-08-10T12:00:00Z',
    user: { id: 99, login: 'octocat', type: 'User' },
  },
};
const defaultReceivedAtMs = Date.parse('2026-08-10T12:10:00Z');

describe('GitHub webhook normalization', () => {
  it('parses a verified delivery exactly once and exposes one top-level pull-request discussion comment', () => {
    const parseJson = vi.fn(() => issueCommentPayload);
    const rawBody = new TextEncoder().encode('{"not":"reparsed"}');

    const normalized = normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-abc',
      receivedAtMs: defaultReceivedAtMs,
      parseJson,
    });

    expect(parseJson).toHaveBeenCalledOnce();
    expect(parseJson).toHaveBeenCalledWith(rawBody);
    expect(normalized.comment).toMatchObject({
      occurrenceKey: 'github:repository:77:issue-comment:444',
      repositoryId: '77',
      endpointKind: 'pullRequest',
      audience: 'shared',
      issueNumber: 12,
      commentId: '444',
      addressingEvidence: 'none',
      actor: { id: '99', login: 'octocat', kind: 'human' },
      isUnsupportedEdit: false,
    });
    expect(normalized).toHaveProperty('automationEvent', null);
  });

  it('does not reinterpret inline review comments as top-level issue comments', () => {
    const normalized = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify(issueCommentPayload)),
      eventType: 'pull_request_review_comment',
      providerDeliveryId: 'delivery-inline',
      receivedAtMs: defaultReceivedAtMs,
    });

    expect(normalized).toMatchObject({
      comment: null,
    });
    expect(normalized).toHaveProperty('automationEvent', null);
  });

  it('normalizes a verified repository push into the exact Automation Event payload and delivery identity', () => {
    const receivedAtMs = Date.parse('2026-08-10T12:02:03Z');
    const parseJson = vi.fn(() => ({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      // Commit authorship is not the provider push occurrence time and may be
      // arbitrarily old after a rebase or cherry-pick.
      head_commit: { timestamp: '2020-01-02T03:04:05Z' },
      repository: { id: 77, full_name: 'acme/widgets' },
      sender: { id: 99, login: 'octocat', type: 'User' },
    }));
    const rawBody = new TextEncoder().encode('{"not":"reparsed"}');

    const normalized = normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'push',
      providerDeliveryId: 'delivery-push',
      receivedAtMs,
      parseJson,
    });

    expect(parseJson).toHaveBeenCalledOnce();
    expect(normalized).toEqual({
      providerDeliveryId: 'delivery-push',
      eventType: 'push',
      comment: null,
      automationEvent: {
        eventRef: {
          pluginId: 'happier.scm.forge.github',
          localId: 'automation/repository-pushed-v1',
        },
        sourceInstanceId: 'github:repository:77',
        occurrenceId: 'github:repository:77:delivery:delivery-push',
        occurredAtMs: receivedAtMs,
        payload: {
          repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
          ref: 'refs/heads/main',
          before: 'a'.repeat(40),
          after: 'b'.repeat(40),
        },
      },
    });
  });

  it('normalizes a ref-deletion push without a head commit', () => {
    const receivedAtMs = Date.parse('2026-08-10T12:02:03Z');
    const normalized = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        ref: 'refs/heads/retired',
        before: 'a'.repeat(40),
        after: '0'.repeat(40),
        deleted: true,
        head_commit: null,
        repository: { id: 77, full_name: 'acme/widgets' },
      })),
      eventType: 'push',
      providerDeliveryId: 'delivery-delete',
      receivedAtMs,
    });

    expect(normalized.automationEvent).toMatchObject({
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/repository-pushed-v1',
      },
      occurrenceId: 'github:repository:77:delivery:delivery-delete',
      occurredAtMs: receivedAtMs,
      payload: {
        ref: 'refs/heads/retired',
        before: 'a'.repeat(40),
        after: '0'.repeat(40),
      },
    });
  });

  it('normalizes issue-opened, pull-request-opened, and pull-request-merged through semantic Event refs', () => {
    const issueOpened = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        action: 'opened',
        repository: { id: 77, full_name: 'acme/widgets' },
        issue: {
          id: 123,
          number: 12,
          title: 'Document exact delivery scope',
          created_at: '2026-08-10T12:03:04Z',
        },
      })),
      eventType: 'issues',
      providerDeliveryId: 'delivery-issue-opened',
      receivedAtMs: defaultReceivedAtMs,
    });
    const pullRequestOpened = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        action: 'opened',
        repository: { id: 77, full_name: 'acme/widgets' },
        pull_request: {
          id: 455,
          number: 33,
          title: 'Add semantic GitHub Events',
          created_at: '2026-08-10T12:04:05Z',
          merged: false,
        },
      })),
      eventType: 'pull_request',
      providerDeliveryId: 'delivery-pr-opened',
      receivedAtMs: defaultReceivedAtMs,
    });
    const pullRequestMerged = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        action: 'closed',
        repository: { id: 77, full_name: 'acme/widgets' },
        pull_request: {
          id: 456,
          number: 34,
          merged: true,
          merged_at: '2026-08-10T12:05:06Z',
          merge_commit_sha: 'c'.repeat(40),
        },
      })),
      eventType: 'pull_request',
      providerDeliveryId: 'delivery-pr-merged',
      receivedAtMs: defaultReceivedAtMs,
    });

    expect(issueOpened.automationEvent).toMatchObject({
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/issue-opened-v1',
      },
      occurrenceId: 'github:repository:77:delivery:delivery-issue-opened',
      occurredAtMs: Date.parse('2026-08-10T12:03:04Z'),
      payload: {
        repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
        issue: { id: '123', number: 12, title: 'Document exact delivery scope' },
      },
    });
    expect(pullRequestOpened.automationEvent).toMatchObject({
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/pull-request-opened-v1',
      },
      occurrenceId: 'github:repository:77:delivery:delivery-pr-opened',
      occurredAtMs: Date.parse('2026-08-10T12:04:05Z'),
      payload: {
        repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
        pullRequest: { id: '455', number: 33, title: 'Add semantic GitHub Events' },
      },
    });
    expect(pullRequestMerged.automationEvent).toMatchObject({
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/pull-request-merged-v1',
      },
      occurrenceId: 'github:repository:77:delivery:delivery-pr-merged',
      occurredAtMs: Date.parse('2026-08-10T12:05:06Z'),
      payload: {
        repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
        pullRequest: { id: '456', number: 34, mergeCommitSha: 'c'.repeat(40) },
      },
    });
  });

  it('ignores a closed but unmerged pull request without requiring a merge timestamp', () => {
    const normalized = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        action: 'closed',
        repository: { id: 77, full_name: 'acme/widgets' },
        pull_request: {
          id: 457,
          number: 35,
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
        },
      })),
      eventType: 'pull_request',
      providerDeliveryId: 'delivery-pr-closed-unmerged',
      receivedAtMs: defaultReceivedAtMs,
    });

    expect(normalized).toMatchObject({
      providerDeliveryId: 'delivery-pr-closed-unmerged',
      eventType: 'pull_request',
      automationEvent: null,
    });
  });

  it('keeps unproven GitHub actors non-authoritative instead of promoting them to humans', () => {
    const organizationComment = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        ...issueCommentPayload,
        comment: {
          ...issueCommentPayload.comment,
          user: { id: 555, login: 'acme', type: 'Organization' },
        },
      })),
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-organization',
      receivedAtMs: defaultReceivedAtMs,
    });
    const missingTypeComment = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(JSON.stringify({
        ...issueCommentPayload,
        comment: {
          ...issueCommentPayload.comment,
          user: { id: 557, login: 'unclassified' },
        },
      })),
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-missing-type',
      receivedAtMs: defaultReceivedAtMs,
    });

    expect(organizationComment.comment?.actor.kind).toBe('unsupported');
    expect(missingTypeComment.comment?.actor.kind).toBe('unsupported');
  });

});
