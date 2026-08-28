import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import {
  GithubIssueLabelAddInputV1Schema,
  GithubPullRequestAddReviewersInputV1Schema,
  GithubPullRequestMergeInputV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestThreadResolutionInputV1Schema,
} from './contracts.js';

const fixture = createTriageSourceV1Fixture();
const target = Object.freeze({
  v: 1 as const,
  instance: fixture.configuredInstance,
  localRef: fixture.getInput.localRef,
  routingToken: 'octocat/hello-world',
});

describe('GitHub mutation input provider constraints', () => {
  it('leaves merge commit text to GitHub and the canonical Action request envelope', () => {
    const parsed = GithubPullRequestMergeInputV1Schema.parse({
      ...target,
      headRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      mergeMethod: 'squash',
      commitTitle: 't'.repeat(1_025),
      commitMessage: 'm'.repeat(16_385),
    });

    expect(parsed.commitTitle).toHaveLength(1_025);
    expect(parsed.commitMessage).toHaveLength(16_385);
  });

  it('treats GraphQL node ids as opaque non-empty strings', () => {
    const threadId = 'opaque-'.repeat(37);
    const parsed = GithubPullRequestThreadResolutionInputV1Schema.parse({
      ...target,
      threadId,
      resolved: true,
    });

    expect(parsed.threadId).toBe(threadId);
  });

  it('does not impose a second byte ceiling on provider-observed reviewer names', () => {
    const observed = 'r'.repeat(256);
    const parsed = GithubPullRequestReviewersResultV1Schema.parse({
      kind: 'applied',
      effect: 'changed',
      requestedReviewers: { users: [observed], teams: [] },
    });

    expect(parsed.requestedReviewers.users).toEqual([observed]);
  });

  it('does not invent a byte ceiling for GitHub team slugs', () => {
    const team = `team-${'a'.repeat(256)}`;
    const parsed = GithubPullRequestAddReviewersInputV1Schema.parse({
      ...target,
      teams: [team],
    });

    expect(parsed.teams).toEqual([team]);
  });

  it('enforces GitHub label names in Unicode code points, not UTF-8 bytes', () => {
    const maximum = '🍎'.repeat(50);
    expect(GithubIssueLabelAddInputV1Schema.safeParse({
      ...target,
      labels: [maximum],
    }).success).toBe(true);
    expect(GithubIssueLabelAddInputV1Schema.safeParse({
      ...target,
      labels: [`${maximum}🍎`],
    }).success).toBe(false);
  });
});
