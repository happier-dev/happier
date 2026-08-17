import { describe, expect, it } from 'vitest';

import issuesListMalformedRows from '../fixtures/issuesListMalformedRows.json' with { type: 'json' };
import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import issuesListPage2 from '../fixtures/issuesListPage2.json' with { type: 'json' };

import {
  TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
  TriageSourceEntrySnapshotV1Schema,
  TriageSourceScanObservationV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { SENTRY_MAX_ROW_FACTS, SENTRY_MAX_TEXT_UTF8_BYTES } from '../sentryContracts.js';
import { toTriagePresentObservation } from '../source/observation.js';
import { mapSentryIssueForInvokedInstance } from './sentryIssueMapping.js';

const SINGLE_LINE_V1 = new RegExp(TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, 'u');

const INVOKED = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '7701',
});
const REQUEST_URL = 'https://us.sentry.io/api/0/organizations/7701/issues/';

function map(raw: unknown, organizationSlug: string | null = 'example-org') {
  return mapSentryIssueForInvokedInstance({
    raw,
    configured: INVOKED,
    requestUrl: REQUEST_URL,
    organizationSlug,
  });
}

function factsOf(raw: unknown): Map<string, unknown> {
  const result = map(raw);
  if (!result.ok) throw new Error('expected a mapped issue');
  return new Map(result.snapshot.facts.map((fact) => [fact.id, fact.value]));
}

/**
 * The row-fact bound is smaller than the number of facts a rich Sentry row can
 * supply, so the emitted prefix alone cannot exercise every value projection.
 * Dropping the higher-priority *provider* fields is the honest way to reach the
 * lower-priority ones: a field-by-field omission is a shape the mapper already
 * contracts to handle (`SENTRY.md` §6.3 — a missing value omits its fact, never
 * the row), and every remaining assertion still runs through the real mapper.
 */
function withoutProviderFields(
  raw: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const row = { ...(raw as Readonly<Record<string, unknown>>) };
  const lifetime = row.lifetime;
  for (const field of fields) delete row[field];
  if (fields.includes('count') || fields.includes('userCount')) {
    row.lifetime = typeof lifetime === 'object' && lifetime !== null
      ? Object.fromEntries(
        Object.entries(lifetime as Readonly<Record<string, unknown>>)
          .filter(([key]) => !fields.includes(key)),
      )
      : lifetime;
  }
  return row;
}

/** Everything the stable table ranks above the counts. */
const ABOVE_COUNTS = Object.freeze([
  'issueCategory', 'issueType', 'level', 'culprit', 'isUnhandled', 'project',
]);
/** Everything the stable table ranks above the assignee. */
const ABOVE_ASSIGNEE = Object.freeze([
  ...ABOVE_COUNTS, 'count', 'userCount', 'lastSeen', 'firstSeen',
]);

describe('mapSentryIssueForInvokedInstance', () => {
  it('preserves escalating and regressed in nativeLabel rather than collapsing them', () => {
    const escalating = map(issuesListPage1.body[0]);
    const regressed = map(issuesListPage2.body[0]);

    expect(escalating.ok && escalating.snapshot.state).toEqual({
      presentation: 'active',
      nativeLabel: 'Escalating',
    });
    expect(regressed.ok && regressed.snapshot.state).toEqual({
      presentation: 'active',
      nativeLabel: 'Regressed',
    });
  });

  it('maps pending_merge to an unknown presentation rather than omitting the row', () => {
    const result = map(issuesListPage2.body[1]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toEqual({
      presentation: 'unknown',
      nativeLabel: 'Pending merge',
    });
    expect(result.snapshot.localRef.entryId).toBe('5501003');
  });

  it('maps the archived substatuses to suppressed with their own native label', () => {
    const result = map(issuesListPage1.body[1]);

    expect(result.ok && result.snapshot.state).toEqual({
      presentation: 'suppressed',
      nativeLabel: 'Archived until escalating',
    });
  });

  it('keeps an unrecognized status visible under the raw provider word', () => {
    const result = map({
      ...issuesListPage1.body[0],
      status: 'quarantined_by_a_future_release',
      substatus: null,
    });

    expect(result.ok && result.snapshot.state).toEqual({
      presentation: 'unknown',
      nativeLabel: 'quarantined_by_a_future_release',
    });
  });

  it('maps a performance issue as one Sentry issue and preserves category and type facts', () => {
    const result = map(issuesListPage1.body[1]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.kindId).toBe('error-issue');
    const facts = new Map(result.snapshot.facts.map((fact) => [fact.id, fact.value]));
    expect(facts.get('issue-category')).toEqual({ kind: 'text', text: 'performance' });
    expect(facts.get('issue-type')).toEqual({
      kind: 'text',
      text: 'performance_n_plus_one_db_queries',
    });
  });

  it('marks every event and user count approximate and keeps the count as a string', () => {
    const facts = factsOf(withoutProviderFields(issuesListPage1.body[0], ABOVE_COUNTS));

    expect(facts.get('events')).toEqual({
      kind: 'number',
      value: '18320',
      format: 'compact',
      approximate: true,
    });
    expect(facts.get('users')).toEqual({
      kind: 'number',
      value: '704',
      format: 'compact',
      approximate: true,
    });
  });

  it('uses lifetime counts and falls back field-by-field for an older self-hosted row', () => {
    const legacy = factsOf(withoutProviderFields(issuesListPage2.body[1], ABOVE_COUNTS));
    expect(legacy.get('events')).toEqual({
      kind: 'number',
      value: '63',
      format: 'compact',
      approximate: true,
    });
    expect(legacy.get('users')).toEqual({
      kind: 'number',
      value: '7',
      format: 'compact',
      approximate: true,
    });

    const partialLifetime = factsOf(withoutProviderFields({
      ...issuesListPage1.body[0],
      lifetime: { count: 'not-a-number', userCount: 704 },
    }, ABOVE_COUNTS));
    expect(partialLifetime.get('events')).toEqual({
      kind: 'number',
      value: '4821',
      format: 'compact',
      approximate: true,
    });
    expect(partialLifetime.get('users')).toEqual({
      kind: 'number',
      value: '704',
      format: 'compact',
      approximate: true,
    });
  });

  it('projects level, culprit, unhandled and project from the row', () => {
    const facts = factsOf(
      withoutProviderFields(issuesListPage1.body[0], ['issueCategory', 'issueType']),
    );

    expect(facts.get('level')).toEqual({ kind: 'status', label: 'error', tone: 'danger' });
    expect(facts.get('culprit')).toEqual({
      kind: 'text',
      text: 'example_service.tasks.send_digest',
    });
    expect(facts.get('unhandled')).toEqual({ kind: 'status', label: 'Unhandled', tone: 'warning' });
    expect(facts.get('project')).toEqual({ kind: 'text', text: 'example-project' });
  });

  it('projects both timestamps as relative instants parsed from the row', () => {
    const facts = factsOf(withoutProviderFields(issuesListPage1.body[0], ABOVE_COUNTS));

    expect(facts.get('last-seen')).toEqual({
      kind: 'timestamp',
      atMs: Date.parse('2026-08-14T07:55:10.000Z'),
      format: 'relative',
    });
    expect(facts.get('first-seen')).toEqual({
      kind: 'timestamp',
      atMs: Date.parse('2026-05-30T11:02:41.000Z'),
      format: 'relative',
    });
  });

  it('renders a user assignment and its priority chip', () => {
    const facts = factsOf(withoutProviderFields(issuesListPage1.body[0], ABOVE_ASSIGNEE));

    expect(facts.get('assignee')).toEqual({
      kind: 'actor',
      displayName: 'Assignee One',
      actorKind: 'user',
    });
    expect(facts.get('priority')).toEqual({ kind: 'status', label: 'high', tone: 'danger' });
  });

  it('renders a team assignment by team name and omits an absent assignee or priority', () => {
    const teamFacts = factsOf(withoutProviderFields(issuesListPage2.body[1], ABOVE_ASSIGNEE));
    expect(teamFacts.get('assignee')).toEqual({
      kind: 'actor',
      displayName: '#platform',
      actorKind: 'team',
    });
    expect(teamFacts.has('priority')).toBe(false);

    const unassigned = factsOf(withoutProviderFields(issuesListPage2.body[0], ABOVE_ASSIGNEE));
    expect(unassigned.has('assignee')).toBe(false);
  });

  it('degrades an unrecognized level to a neutral chip rather than dropping it', () => {
    const facts = factsOf({ ...issuesListPage1.body[0], level: 'sample' });
    expect(facts.get('level')).toEqual({ kind: 'status', label: 'sample', tone: 'neutral' });
  });

  it('emits last-release as a detail-only fact rather than omitting or inventing it', () => {
    const result = map(withoutProviderFields(issuesListPage1.body[1], [
      ...ABOVE_ASSIGNEE, 'assignedTo', 'priority',
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lastRelease = result.snapshot.facts.find((fact) => fact.id === 'last-release');
    expect(lastRelease?.value).toEqual({ kind: 'detailOnly' });
  });

  it('never puts a mutable locator field into identity and never emits a routingToken', () => {
    const result = map(issuesListPage1.body[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.localRef.entryId).toBe('5501001');
    expect(result.snapshot.localRef.collisionScope).not.toContain('example-org');
    expect(result.snapshot.localRef.collisionScope).not.toContain('EXAMPLE-PROJECT-3F');
    // Asserted on the PUBLISHED locator: `truncated` is a plugin-local projection fact that
    // feeds `projectionTruncated`, and it must never reach the wire.
    expect(Object.keys(toTriagePresentObservation(result.snapshot).locator).sort())
      .toEqual(['displayPath', 'v', 'webUrl']);
  });

  it('takes sourceUpdatedAtMs from lastSeen and never from a host clock', () => {
    const result = map(issuesListPage1.body[0]);
    expect(result.ok && result.snapshot.sourceUpdatedAtMs)
      .toBe(Date.parse('2026-08-14T07:55:10.000Z'));

    const withoutLastSeen = map({ ...issuesListPage1.body[0], lastSeen: null });
    expect(withoutLastSeen.ok && withoutLastSeen.snapshot.sourceUpdatedAtMs).toBeNull();
  });

  it('keeps a valid issue with a 20KB title, huge culprit and excess facts present', () => {
    const result = map({
      ...issuesListPage1.body[0],
      title: 'T'.repeat(20 * 1024),
      culprit: 'C'.repeat(20 * 1024),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.projectionTruncated).toBe(true);
    expect(new TextEncoder().encode(result.snapshot.title).byteLength)
      .toBeLessThanOrEqual(SENTRY_MAX_TEXT_UTF8_BYTES);
    expect(result.snapshot.facts.length).toBeLessThanOrEqual(SENTRY_MAX_ROW_FACTS);
    expect(result.snapshot.localRef.entryId).toBe('5501001');
    expect(result.snapshot.state.presentation).toBe('active');
  });

  it('reports projectionTruncated false when nothing was shortened', () => {
    // A row inside the fact bound with no oversized text: the flag must stay
    // false so it keeps meaning "this source shortened nothing".
    const result = map(withoutProviderFields(issuesListPage2.body[1], ABOVE_ASSIGNEE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.facts.length).toBeLessThanOrEqual(SENTRY_MAX_ROW_FACTS);
    expect(result.snapshot.projectionTruncated).toBe(false);
  });

  it('drops only the lowest-priority fact tail when the fact bound is exceeded', () => {
    const result = map(issuesListPage1.body[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.snapshot.facts.map((fact) => fact.id);
    expect(ids.length).toBe(SENTRY_MAX_ROW_FACTS);
    expect(ids[0]).toBe('issue-category');
    expect(ids).toContain('level');
    expect(ids).toContain('culprit');
    expect(ids).not.toContain('last-release');
    expect(result.snapshot.projectionTruncated).toBe(true);
  });

  it('omits only the malformed rows of a mixed page and keeps every valid sibling', () => {
    const rows = issuesListMalformedRows.body;
    const mapped = rows.map((row) => map(row));

    expect(mapped.filter((result) => result.ok).length).toBe(2);
    expect(mapped.filter((result) => !result.ok).length).toBe(3);
    for (const result of mapped) {
      if (!result.ok) expect(result.reason).toBe('malformed-row');
    }
  });

  it('omits a row whose identity is missing, non-string or over the identifier bound', () => {
    for (const raw of [
      { ...issuesListPage1.body[0], id: undefined },
      { ...issuesListPage1.body[0], id: 5501001 },
      { ...issuesListPage1.body[0], id: '' },
      { ...issuesListPage1.body[0], id: '9'.repeat(1024) },
      null,
      'a string row',
      [],
    ]) {
      const result = map(raw);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed-row');
    }
  });

  it('fails closed when the invoked route disagrees with the exact configured instance', () => {
    const result = mapSentryIssueForInvokedInstance({
      raw: issuesListPage1.body[0],
      configured: INVOKED,
      requestUrl: 'https://us.sentry.io/api/0/organizations/7702/issues/',
      organizationSlug: 'example-org',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'scope-mismatch') return;
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-invoked-organization-mismatch',
    });
  });

  it('sets scopeLabel from the project display name and falls back deterministically', () => {
    const named = map(issuesListPage1.body[0]);
    expect(named.ok && named.snapshot.scopeLabel).toBe('Example Project');

    const slugOnly = map({
      ...issuesListPage1.body[0],
      project: { id: '9001', slug: 'example-project' },
    });
    expect(slugOnly.ok && slugOnly.snapshot.scopeLabel).toBe('example-project');

    const organizationOnly = map({ ...issuesListPage1.body[0], project: null });
    expect(organizationOnly.ok && organizationOnly.snapshot.scopeLabel).toBe('example-org');
  });
  it('publishes a multi-line exception title as one line instead of rejecting its page', () => {
    // A Sentry exception message routinely carries a newline; the strict target
    // rejects a control-bearing result ATOMICALLY, so one such row would discard
    // every other issue on the same scan page.
    const result = map({
      ...issuesListPage1.body[0],
      title: 'TypeError: cannot read x\n  at render (app.tsx:12)',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.title)
      .toBe('TypeError: cannot read x at render (app.tsx:12)');
    // Collapsing a control run loses no content, so it must not be charged as
    // truncation: the flag stays whatever the unmodified fixture row already produced.
    const baseline = map(issuesListPage1.body[0]);
    expect(result.snapshot.projectionTruncated)
      .toBe(baseline.ok && baseline.snapshot.projectionTruncated);
    expect(() => TriageSourceEntrySnapshotV1Schema.parse(
      toTriagePresentObservation(result.snapshot).snapshot,
    )).not.toThrow();
  });

  it('publishes a control-bearing project name as a one-line scope label', () => {
    const row = issuesListPage1.body[0] as Readonly<Record<string, unknown>>;
    const result = map({
      ...row,
      project: {
        ...(row.project as Readonly<Record<string, unknown>>),
        name: 'checkout\tweb',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SINGLE_LINE_V1.test(result.snapshot.scopeLabel)).toBe(true);
    expect(result.snapshot.scopeLabel).toBe('checkout web');
  });
  it('publishes an unrecognized provider status as one bounded line', () => {
    // `status` is a bare provider string, and this mapper documents an unrecognized
    // value as EXPECTED. It reaches `state.nativeLabel`, which is a single-line,
    // byte-bounded V1 string — so an unnormalized one rejects the whole page.
    const result = map({ ...issuesListPage1.body[0], status: 'needs\ntriage', substatus: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const published = toTriagePresentObservation(result.snapshot).snapshot;
    expect(published.state).toEqual({ presentation: 'unknown', nativeLabel: 'needs triage' });
    expect(() => TriageSourceEntrySnapshotV1Schema.parse(published)).not.toThrow();
  });

  it('omits nativeLabel rather than publishing a blank one when the status is unusable', () => {
    const result = map({ ...issuesListPage1.body[0], status: 7, substatus: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => TriageSourceEntrySnapshotV1Schema.parse(
      toTriagePresentObservation(result.snapshot).snapshot,
    )).not.toThrow();
  });
});
describe('Sentry locator bounds', () => {
  /**
   * A self-hosted Sentry issue link: a long deployment host, an organization-scoped
   * route, and the event-and-query tail Sentry's own links carry. Sentry publishes no
   * ceiling for `permalink`, so this source cannot assume one — the projection bounds it.
   */
  const LONG_PERMALINK = 'https://sentry.observability.platform-engineering'
    + '.contoso-manufacturing-emea.example.com'
    + '/organizations/platform-engineering-emea-observability'
    + '/issues/5501001/events/9f2c4d1e8b7a4c3f9d0e1a2b3c4d5e6f'
    + '/?project=4504991827364554&query=is%3Aunresolved+issue.category%3Aerror'
    + '&referrer=issue-stream&statsPeriod=14d&environment=production-emea-west'
    + '&sort=freq&groupStatsPeriod=auto&utc=false&cursor=0%3A100%3A0';

  it('keeps an issue whose provider link exceeds the published location ceiling', () => {
    const result = map({ ...issuesListPage1.body[0], permalink: LONG_PERMALINK });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = toTriagePresentObservation(result.snapshot);
    // The strict target rejects a result ATOMICALLY, so the row surviving is the contract:
    // one long provider link must not discard every sibling row on the same scan page.
    expect(() => TriageSourceScanObservationV1Schema.parse(observation)).not.toThrow();
    expect(observation.localRef.entryId).toBe(String(issuesListPage1.body[0]!.id));
    // A location is machine-meaningful, so it is never cut into a different destination.
    // A permalink this source cannot publish is unusable in exactly the sense the existing
    // fallback already covers, so the row keeps the source's own route to the same issue.
    expect(observation.locator.webUrl)
      .toBe('https://us.sentry.io/organizations/example-org/issues/5501001/');
  });

  it('publishes a control-bearing permalink as a usable link rather than a rejected row', () => {
    const result = map({
      ...issuesListPage1.body[0],
      permalink: 'https://example-org.sentry.io/issues/5501001/\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = toTriagePresentObservation(result.snapshot);
    expect(() => TriageSourceScanObservationV1Schema.parse(observation)).not.toThrow();
    // A permalink this source cannot publish as a V1 single-line string is not a reason to
    // lose the entry: the source's own organization-scoped route stands in for it.
    expect(observation.locator.webUrl)
      .toBe('https://us.sentry.io/organizations/example-org/issues/5501001/');
  });

  it('bounds a locator built from provider slugs it does not get to limit', () => {
    const row = issuesListPage1.body[0] as Readonly<Record<string, unknown>>;
    const result = map({
      ...row,
      permalink: null,
      project: { ...(row.project as Readonly<Record<string, unknown>>), slug: 'p'.repeat(600) },
      shortId: `${'P'.repeat(600)}-3F`,
    }, 'o'.repeat(600));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = toTriagePresentObservation(result.snapshot);
    expect(() => TriageSourceScanObservationV1Schema.parse(observation)).not.toThrow();
    expect(observation.localRef.entryId).toBe(String(row.id));
    // Display text is shortened rather than dropped, so the row still reads as itself.
    expect(observation.locator.displayPath).not.toBeUndefined();
    expect(new TextEncoder().encode(observation.locator.displayPath ?? '').byteLength)
      .toBeLessThanOrEqual(SENTRY_MAX_TEXT_UTF8_BYTES);
    // With no publishable destination left, the field is omitted and the loss is announced.
    expect(observation.locator.webUrl).toBeUndefined();
    expect(observation.snapshot.projectionTruncated).toBe(true);
  });
});
