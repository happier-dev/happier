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

describe('GitHub webhook normalization', () => {
  it('parses a verified delivery exactly once and exposes one top-level pull-request discussion comment', () => {
    const parseJson = vi.fn(() => issueCommentPayload);
    const rawBody = new TextEncoder().encode('{"not":"reparsed"}');

    const normalized = normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-abc',
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
    });

    expect(normalized).toMatchObject({
      comment: null,
    });
    expect(normalized).toHaveProperty('automationEvent', null);
  });

  it('normalizes a verified repository push into the exact Automation Event payload and delivery identity', () => {
    const parseJson = vi.fn(() => ({
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      head_commit: { timestamp: '2026-08-10T12:01:02Z' },
      repository: { id: 77, full_name: 'acme/widgets' },
      sender: { id: 99, login: 'octocat', type: 'User' },
    }));
    const rawBody = new TextEncoder().encode('{"not":"reparsed"}');

    const normalized = normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'push',
      providerDeliveryId: 'delivery-push',
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
        occurredAtMs: Date.parse('2026-08-10T12:01:02Z'),
        payload: {
          repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
          ref: 'refs/heads/main',
          before: 'a'.repeat(40),
          after: 'b'.repeat(40),
        },
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
    });

    expect(issueOpened.automationEvent).toMatchObject({
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/issue-opened-v1',
      },
      occurrenceId: 'github:repository:77:delivery:delivery-issue-opened',
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
      payload: {
        repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
        pullRequest: { id: '456', number: 34, mergeCommitSha: 'c'.repeat(40) },
      },
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
    });

    expect(organizationComment.comment?.actor.kind).toBe('unsupported');
    expect(missingTypeComment.comment?.actor.kind).toBe('unsupported');
  });

});
