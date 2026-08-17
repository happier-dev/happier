import { describe, expect, it } from 'vitest';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from '../../triage/contribution.js';
import { projectGitlabDetailBody } from './model.js';

const SOURCE_CONTRIBUTION = Object.freeze({ pluginId: 'happier.gitlab', localId: 'gitlab-forge' });
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: 'happier.gitlab', localId: 'gitlab-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'gitlab-com',
  configuration: Object.freeze({ v: 1, token: 'gitlab-configuration-token-v1' }),
});

function detailInput(
  overrides: Readonly<{
    kindId?: string;
    facts?: readonly unknown[];
    snapshot?: Readonly<Record<string, unknown>>;
    viewer?: Readonly<Record<string, unknown>>;
    locator?: Readonly<Record<string, unknown>>;
    linkedSessions?: readonly unknown[];
  }> = {},
): TriageDetailSurfaceInputV1 {
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: overrides.kindId ?? 'merge-request',
        collisionScope: 'gitlab.com:group/project',
        entryId: '412',
      },
      observedAtMs: 1_760_000_700_000,
      locator: overrides.locator ?? {
        v: 1,
        webUrl: 'https://gitlab.com/group/project/-/merge_requests/412',
        displayPath: 'group/project !412',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        summary: 'Removes the second owner of the same decision.',
        scopeLabel: 'group/project',
        state: { presentation: 'active', nativeLabel: 'Opened' },
        facts: overrides.facts ?? [],
        ...overrides.snapshot,
      },
      viewer: {
        involvement: ['reviewRequested'],
        ...overrides.viewer,
      },
    },
    linkedSessions: overrides.linkedSessions ?? [],
  });
}

describe('projectGitlabDetailBody', () => {
  it('renders none of the common header the aggregate owns', () => {
    // `CONTRACT.md` §7 and `core/SURFACE.md` §2.2: the Triage plugin owns one permanently
    // mounted common header carrying the title, source and kind, attention and the Session
    // relationship. A source body that projects them too is a second renderer of one header.
    const body = projectGitlabDetailBody(detailInput({
      viewer: {
        involvement: ['reviewRequested'],
        sourceAttention: {
          level: 'required',
          reasonId: 'gitlab/review-requested',
          reasonLabel: 'Your review is requested',
        },
      },
    }));

    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain('Consolidate the duplicated normalizer');
    expect(encoded).not.toContain('Removes the second owner of the same decision.');
    expect(encoded).not.toContain('Your review is requested');
    expect(encoded).not.toContain('reviewRequested');
    expect(encoded).not.toContain('Opened');
    expect(encoded).not.toContain('group/project');
    expect(encoded).not.toContain('https://gitlab.com');
    expect(Object.keys(body).sort()).toEqual(['fields', 'kindId', 'linkedSessions']);
  });

  it('carries the declared kind id, which selects the composition', () => {
    // The kind id is the branch that decides whether a `Work Sessions` panel exists; the
    // header is what names the kind to the reader.
    expect(projectGitlabDetailBody(detailInput({ kindId: 'issue' })).kindId).toBe('issue');
    expect(projectGitlabDetailBody(detailInput()).kindId).toBe('merge-request');
    expect(projectGitlabDetailBody(detailInput({ kindId: 'epic' })).kindId).toBe('epic');
  });

  it('labels every GitLab fact id it owns and preserves each value arm', () => {
    const body = projectGitlabDetailBody(detailInput({
      facts: [
        {
          id: 'gitlab/merge-status',
          importance: 'secondary',
          value: { kind: 'status', value: 'Conflicts', tone: 'danger' },
        },
        { id: 'gitlab/iid', importance: 'primary', value: { kind: 'text', value: '!412' } },
        { id: 'gitlab/author', importance: 'secondary', value: { kind: 'actor', value: 'ada' } },
        {
          id: 'gitlab/approved',
          importance: 'primary',
          value: { kind: 'detailOnly' },
        },
      ],
    }));

    expect(body.fields).toEqual([
      {
        kind: 'status',
        id: 'gitlab/merge-status',
        label: 'Merge status',
        importance: 'secondary',
        value: 'Conflicts',
        tone: 'danger',
      },
      {
        kind: 'text',
        id: 'gitlab/iid',
        label: 'Number',
        importance: 'primary',
        value: '!412',
      },
      {
        kind: 'text',
        id: 'gitlab/author',
        label: 'Author',
        importance: 'secondary',
        value: 'ada',
      },
      {
        kind: 'pending',
        id: 'gitlab/approved',
        label: 'Approvals',
        importance: 'primary',
      },
    ]);
  });

  it('preserves the counted and timed value arms with their display format', () => {
    const body = projectGitlabDetailBody(detailInput({
      facts: [
        {
          id: 'gitlab/comments',
          importance: 'supplementary',
          value: { kind: 'number', value: 7, format: 'compact' },
        },
        {
          id: 'gitlab/native-window',
          label: 'Window',
          importance: 'supplementary',
          value: { kind: 'timestamp', atMs: 1_760_000_500_000, format: 'relative' },
        },
      ],
    }));

    expect(body.fields).toEqual([
      {
        kind: 'number',
        id: 'gitlab/comments',
        label: 'Comments',
        importance: 'supplementary',
        value: 7,
        format: 'compact',
        approximate: false,
      },
      {
        kind: 'timestamp',
        // A fact this build has no label for keeps the source's own label rather than
        // being shown as a raw id.
        id: 'gitlab/native-window',
        label: 'Window',
        importance: 'supplementary',
        atMs: 1_760_000_500_000,
        format: 'relative',
      },
    ]);
  });

  it('keeps a retained link whose Session summary is unavailable', () => {
    const body = projectGitlabDetailBody(detailInput({
      linkedSessions: [{ sessionId: 'session-tombstoned' }],
    }));

    expect(body.linkedSessions).toEqual([{ sessionId: 'session-tombstoned' }]);
  });
});
