import { describe, expect, it, vi } from 'vitest';

import {
  GithubWebhookPayloadError,
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
const pullRequestSourceFacts = {
  user: { id: 99, login: 'octocat', type: 'User' },
  head: { sha: 'a'.repeat(40), ref: 'preview', repo: { id: 77, full_name: 'acme/widgets' } },
  base: { ref: 'main', repo: { id: 77, full_name: 'acme/widgets' } },
};

describe('GitHub webhook normalization', () => {
  it.each(['opened', 'reopened', 'synchronize', 'closed', 'merged'] as const)(
    'projects %s with exact head and neutral repository identities without using the sender as author', action => {
      const delivery = normalizeGithubWebhookDelivery({ eventType: 'pull_request', providerDeliveryId: `pr-${action}`, receivedAtMs: defaultReceivedAtMs,
        rawBody: new TextEncoder().encode(JSON.stringify({ action: action === 'merged' ? 'closed' : action,
          repository: { id: 77, full_name: 'acme/widgets' },
          sender: { id: 999, login: 'other-person', type: 'User' },
          pull_request: { id: 455, number: 33, title: 'Preview', merged: action === 'merged',
            created_at: '2026-08-10T12:04:05Z', updated_at: '2026-08-10T12:05:06Z',
            closed_at: '2026-08-10T12:05:06Z', merged_at: '2026-08-10T12:05:06Z', merge_commit_sha: 'c'.repeat(40),
            user: { id: 99, login: 'octocat', type: 'User' },
            head: { sha: 'a'.repeat(40), ref: 'preview', repo: { id: 78, full_name: 'Octocat/Widgets' } },
            base: { ref: 'main', repo: { id: 77, full_name: 'Acme/Widgets' } },
          } })) });
      expect(delivery.automationEvents).toContainEqual(expect.objectContaining({
        eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/pull-request-lifecycle-v1' },
        payload: { repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' }, pullRequest: {
          id: '455', number: 33, action, headSha: 'a'.repeat(40), headRef: 'preview', baseRef: 'main',
          baseRepository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
          headRepository: { kind: 'github', deployment: 'https://github.com', repository: 'octocat/widgets' },
          author: { id: '99', login: 'octocat', kind: 'human' },
        } },
      }));
    },
  );
  it('retains a closed pull request with a deleted source repository and rejects a shortened head SHA', () => {
    const delivery = (sha: string) => normalizeGithubWebhookDelivery({ eventType: 'pull_request', providerDeliveryId: 'deleted-head', receivedAtMs: defaultReceivedAtMs,
      rawBody: new TextEncoder().encode(JSON.stringify({ action: 'closed', repository: { id: 77, full_name: 'acme/widgets' },
        pull_request: { ...pullRequestSourceFacts, id: 455, number: 33, merged: false, closed_at: '2026-08-10T12:05:06Z',
          head: { ...pullRequestSourceFacts.head, repo: null, sha } } })) });
    expect(delivery('a'.repeat(40)).automationEvents).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      pullRequest: expect.objectContaining({ action: 'closed', headRepository: null, headSha: 'a'.repeat(40) }),
    }) })]);
    expect(() => delivery('a'.repeat(7))).toThrow();
  });
  it.each(['requested', 'approved', 'rejected'])('projects deployment_review/%s only to its exact delivered run', action => {
    const delivery = normalizeGithubWebhookDelivery({ eventType: 'deployment_review', providerDeliveryId: 'review-1', receivedAtMs: defaultReceivedAtMs,
      rawBody: new TextEncoder().encode(JSON.stringify({ action, repository: { id: 77, full_name: 'acme/widgets' }, workflow_run: { id: 81 } })) });
    expect(delivery).toHaveProperty('deploymentRun', { repositoryId: '77', repositoryNameWithOwner: 'acme/widgets', runId: '81' });
    expect(delivery.automationEvent).toBeNull();
  });

  it('projects workflow_run completion to the same exact-run wake and ignores a nullable deployment run', () => {
    const normalize = (eventType: string, workflow_run: unknown) => normalizeGithubWebhookDelivery({ eventType, providerDeliveryId: 'run-1', receivedAtMs: defaultReceivedAtMs,
      rawBody: new TextEncoder().encode(JSON.stringify({ action: 'completed', repository: { id: 77, full_name: 'acme/widgets' }, workflow_run })) });
    expect(normalize('workflow_run', { id: 81 })).toHaveProperty('deploymentRun', { repositoryId: '77', repositoryNameWithOwner: 'acme/widgets', runId: '81' });
    expect(normalize('deployment_review', null).automationEvent).toBeNull();
  });
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
      automationEvents: [normalized.automationEvent],
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
          ...pullRequestSourceFacts,
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
          ...pullRequestSourceFacts,
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
          ...pullRequestSourceFacts,
          id: 457,
          number: 35,
          merged: false,
          merged_at: null,
          closed_at: '2026-08-10T12:05:06Z',
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

  it('bypasses the dormant issue-comment deep parse for a route with no comment consumer', () => {
    const malformedCommentBody = JSON.stringify({
      action: 'created',
      repository: { id: 77, full_name: 'acme/widgets' },
      issue: { id: 300, number: 12 },
      comment: { id: 'not-a-positive-integer' },
    });

    // The webhook route settles a comment delivery as ignored because no
    // consumer exists, so a comment body it can never consume must not
    // dead-letter the delivery through a deep parse it never needed.
    const normalized = normalizeGithubWebhookDelivery({
      rawBody: new TextEncoder().encode(malformedCommentBody),
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-no-consumer',
      receivedAtMs: defaultReceivedAtMs,
      consumesIssueComments: false,
    });
    expect(normalized).toEqual({
      providerDeliveryId: 'delivery-no-consumer',
      eventType: 'issue_comment',
      comment: null,
      automationEvent: null,
      automationEvents: [],
    });
  });

  it('keeps the strict issue-comment parse for consumer routes and by default', () => {
    const malformedCommentBody = JSON.stringify({
      action: 'created',
      repository: { id: 77, full_name: 'acme/widgets' },
      issue: { id: 300, number: 12 },
      comment: { id: 'not-a-positive-integer' },
    });
    const rawBody = new TextEncoder().encode(malformedCommentBody);

    expect(() => normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-consumer',
      receivedAtMs: defaultReceivedAtMs,
      consumesIssueComments: true,
    })).toThrow(GithubWebhookPayloadError);
    expect(() => normalizeGithubWebhookDelivery({
      rawBody,
      eventType: 'issue_comment',
      providerDeliveryId: 'delivery-default',
      receivedAtMs: defaultReceivedAtMs,
    })).toThrow(GithubWebhookPayloadError);
  });

});
