import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';

import { projectGithubDetailBody } from './model.js';

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.scm.forge.github',
  localId: 'github-forge',
});
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.scm.forge.github',
        localId: 'github-account',
      }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'github.com',
  configuration: Object.freeze({ v: 1, token: 'github-configuration-token-v1' }),
});

function detailInput(
  overrides: Readonly<{
    kindId?: string;
    facts?: readonly unknown[];
    viewer?: Readonly<Record<string, unknown>>;
    linkedSessions?: readonly unknown[];
  }> = {},
): TriageDetailSurfaceInputV1 {
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: overrides.kindId ?? 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://github.com/octo-org/example-app/pull/1284',
        displayPath: 'octo-org/example-app#1284',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: overrides.facts ?? [],
      },
      viewer: {
        involvement: ['reviewRequested'],
        ...overrides.viewer,
      },
    },
    linkedSessions: overrides.linkedSessions ?? [],
  });
}

describe('projectGithubDetailBody', () => {
  it('renders none of the common header the aggregate owns', () => {
    // The Triage plugin owns one permanently mounted common header carrying the title,
    // source and kind, attention and the Session relationship. A source body that projects
    // them too is a second renderer of one header, and the copy that drifts is the one the
    // user is looking at.
    const body = projectGithubDetailBody(detailInput({
      viewer: {
        involvement: ['reviewRequested'],
        sourceAttention: {
          level: 'required',
          reasonId: 'github/review-requested',
          reasonLabel: 'Review requested',
        },
      },
    }));

    expect(Object.keys(body).sort()).toEqual(['fields', 'kindId', 'linkedSessions']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Consolidate the duplicated normalizer');
    expect(serialized).not.toContain('Review requested');
    expect(serialized).not.toContain('github.com/octo-org');
  });

  it('projects every GitHub fact arm and keeps a deferred fact distinct from an absent one', () => {
    const body = projectGithubDetailBody(detailInput({
      facts: [
        { id: 'github/author', importance: 'secondary', value: { kind: 'actor', value: 'octocat' } },
        {
          id: 'github/updated',
          importance: 'secondary',
          value: { kind: 'timestamp', atMs: 1_760_000_000_000, format: 'relative' },
        },
        {
          id: 'github/comments',
          importance: 'supplementary',
          value: { kind: 'number', value: 12, format: 'compact' },
        },
        {
          id: 'github/checks',
          importance: 'primary',
          value: { kind: 'status', value: '2 failing', tone: 'danger' },
        },
      ],
    }));

    expect(body.fields).toEqual([
      { kind: 'text', id: 'github/author', label: 'Author', importance: 'secondary', value: 'octocat' },
      {
        kind: 'timestamp',
        id: 'github/updated',
        label: 'Updated',
        importance: 'secondary',
        atMs: 1_760_000_000_000,
        format: 'relative',
      },
      {
        kind: 'number',
        id: 'github/comments',
        label: 'Comments',
        importance: 'supplementary',
        value: 12,
        format: 'compact',
        approximate: false,
      },
      {
        kind: 'status',
        id: 'github/checks',
        label: 'Checks',
        importance: 'primary',
        value: '2 failing',
        tone: 'danger',
      },
    ]);
  });

  it('keeps a detail-only fact as pending rather than as an absent one', () => {
    // Answered-elsewhere and cannot-report must not render alike, which is the whole
    // reason the published value union carries a `detailOnly` arm at all.
    const body = projectGithubDetailBody(detailInput({
      facts: [{
        id: 'github/additions-deletions',
        importance: 'supplementary',
        value: { kind: 'detailOnly' },
      }],
    }));

    expect(body.fields).toEqual([{
      kind: 'pending',
      id: 'github/additions-deletions',
      label: 'Changes',
      importance: 'supplementary',
    }]);
  });

  it('keeps a linked Session whose summary is unavailable instead of dropping the link', () => {
    const body = projectGithubDetailBody(detailInput({
      kindId: 'issue',
      linkedSessions: [
        { sessionId: 'session-1', displayTitle: 'Fix the normalizer' },
        { sessionId: 'session-2' },
      ],
    }));

    // A retained link that lost only its display text is never presented as "never
    // linked": the id survives and the renderer says the details are unavailable.
    expect(body.kindId).toBe('issue');
    expect(body.linkedSessions.map((session) => session.sessionId))
      .toEqual(['session-1', 'session-2']);
    expect(body.linkedSessions[1]?.displayTitle).toBeUndefined();
  });
});
