import { describe, expect, it } from 'vitest';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

import { SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_PLUGIN_ID } from '../../sentryContracts.js';
import { projectSentryDetailOverview } from './model.js';

const SOURCE_CONTRIBUTION = Object.freeze({ pluginId: SENTRY_PLUGIN_ID, localId: 'sentry' });
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '4f1d1f9c-6d5e-4a52-8f21-8f6cc4c93a10',
  }),
  binding: Object.freeze({
    purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'acme',
  configuration: Object.freeze({ v: 1, token: 'sentry-configuration-token-v1' }),
});

type SnapshotOverrides = Readonly<Record<string, unknown>>;

function detailInput(
  overrides: Readonly<{
    facts?: readonly unknown[];
    snapshot?: SnapshotOverrides;
    viewer?: Readonly<Record<string, unknown>>;
    locator?: Readonly<Record<string, unknown>>;
    linkedSessions?: readonly unknown[];
    sourceUpdatedAtMs?: number;
  }> = {},
): TriageDetailSurfaceInputV1 {
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: 'error-issue',
        collisionScope: 'acme',
        entryId: '6001',
      },
      observedAtMs: 1_760_000_700_000,
      locator: overrides.locator ?? {
        v: 1,
        webUrl: 'https://acme.sentry.io/issues/6001/',
      },
      snapshot: {
        v: 1,
        title: 'TypeError: cannot read property',
        summary: 'app/checkout.ts in submit',
        scopeLabel: 'checkout-web',
        state: { presentation: 'active', nativeLabel: 'Escalating' },
        facts: overrides.facts ?? [],
        ...overrides.snapshot,
      },
      viewer: {
        involvement: ['assignee'],
        ...overrides.viewer,
      },
      ...(overrides.sourceUpdatedAtMs === undefined
        ? {}
        : { sourceUpdatedAtMs: overrides.sourceUpdatedAtMs }),
    },
    linkedSessions: overrides.linkedSessions ?? [],
  });
}

describe('projectSentryDetailOverview', () => {
  it('projects the applied observation without reading a provider', () => {
    const overview = projectSentryDetailOverview(detailInput({
      sourceUpdatedAtMs: 1_760_000_600_000,
      linkedSessions: [{ sessionId: 'session-1', displayTitle: 'Fix checkout crash' }],
      viewer: {
        involvement: ['assignee'],
        sourceAttention: {
          level: 'required',
          reasonId: 'sentry/escalating',
          reasonLabel: 'This issue is escalating',
        },
      },
    }));

    expect(overview).toEqual({
      summary: 'app/checkout.ts in submit',
      projectionTruncated: false,
      fields: [],
      observedAtMs: 1_760_000_700_000,
      sourceUpdatedAtMs: 1_760_000_600_000,
    });
    // Title, presentation state, scope, attention, viewer involvement and the
    // linked Happier Sessions belong to the aggregate detail shell. This source
    // must not become a second owner of any of them.
    const owned = new Set(Object.keys(overview));
    for (const chrome of [
      'title',
      'scopeLabel',
      'state',
      'webUrl',
      'involvement',
      'attention',
      'linkedSessions',
    ]) {
      expect(owned.has(chrome)).toBe(false);
    }
  });

  // One observation carries at most the published row-fact bound, so the arms are
  // proved across two observations rather than by overfilling one.
  it('labels every Sentry fact id it owns and preserves each value arm', () => {
    const overview = projectSentryDetailOverview(detailInput({
      facts: [
        { id: 'level', importance: 'primary', value: { kind: 'status', value: 'error', tone: 'danger' } },
        { id: 'culprit', importance: 'primary', value: { kind: 'text', value: 'app/checkout.ts' } },
        { id: 'assignee', importance: 'secondary', value: { kind: 'actor', value: 'Ada Lovelace' } },
        {
          id: 'events',
          importance: 'secondary',
          value: { kind: 'number', value: 4210, format: 'compact', approximate: true },
        },
      ],
    }));
    const remaining = projectSentryDetailOverview(detailInput({
      facts: [
        {
          id: 'last-seen',
          importance: 'secondary',
          value: { kind: 'timestamp', atMs: 1_760_000_500_000, format: 'relative' },
        },
        { id: 'last-release', importance: 'supplementary', value: { kind: 'detailOnly' } },
      ],
    }));

    expect(overview.fields).toEqual([
      {
        kind: 'status',
        id: 'level',
        label: 'Level',
        importance: 'primary',
        value: 'error',
        tone: 'danger',
      },
      {
        kind: 'text',
        id: 'culprit',
        label: 'Culprit',
        importance: 'primary',
        value: 'app/checkout.ts',
      },
      {
        kind: 'text',
        id: 'assignee',
        label: 'Assignee',
        importance: 'secondary',
        value: 'Ada Lovelace',
      },
      {
        kind: 'number',
        id: 'events',
        label: 'Events',
        importance: 'secondary',
        value: 4210,
        format: 'compact',
        approximate: true,
      },
    ]);
    expect(remaining.fields).toEqual([
      {
        kind: 'timestamp',
        id: 'last-seen',
        label: 'Last seen',
        importance: 'secondary',
        atMs: 1_760_000_500_000,
        format: 'relative',
      },
      {
        kind: 'pending',
        id: 'last-release',
        label: 'Last release',
        importance: 'supplementary',
      },
    ]);
  });

  it('owns the label for its known ids, then falls back to the fact label and the id', () => {
    const overview = projectSentryDetailOverview(detailInput({
      facts: [
        {
          id: 'level',
          label: 'Severity',
          importance: 'primary',
          value: { kind: 'status', value: 'fatal', tone: 'danger' },
        },
        {
          id: 'sentry-carried-label',
          label: 'Carried label',
          importance: 'secondary',
          value: { kind: 'text', value: 'carried' },
        },
        {
          id: 'sentry-unlabelled',
          importance: 'secondary',
          value: { kind: 'text', value: 'raw' },
        },
      ],
    }));

    expect(overview.fields).toEqual([
      {
        kind: 'status',
        id: 'level',
        label: 'Level',
        importance: 'primary',
        value: 'fatal',
        tone: 'danger',
      },
      {
        kind: 'text',
        id: 'sentry-carried-label',
        label: 'Carried label',
        importance: 'secondary',
        value: 'carried',
      },
      {
        kind: 'text',
        id: 'sentry-unlabelled',
        label: 'sentry-unlabelled',
        importance: 'secondary',
        value: 'raw',
      },
    ]);
  });

  it('reports a shortened snapshot rather than hiding it', () => {
    const overview = projectSentryDetailOverview(detailInput({
      snapshot: { projectionTruncated: true },
      locator: { v: 1, displayPath: 'checkout-web / 6001' },
    }));

    expect(overview.projectionTruncated).toBe(true);
    expect(overview.summary).toBe('app/checkout.ts in submit');
  });
});
