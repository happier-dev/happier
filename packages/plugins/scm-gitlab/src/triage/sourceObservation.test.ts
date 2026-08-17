import { TriageSourceScanObservationV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { decodeGitlabRow } from './mapping/gitlabEntry.js';
import { normalizeGitlabConfiguredBaseUrl } from './origin.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';

function originOf(baseUrl: string) {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) throw new Error(`unusable base url: ${baseUrl}`);
  return origin;
}

const GITLAB_COM = originOf('https://gitlab.com');

/**
 * GitLab nests groups up to twenty levels deep and each level carries its own name, so a
 * real enterprise namespace is long enough to overrun the routing, location, and display
 * bounds at once. This is provider-shaped data, not a synthetic 20 KB string.
 */
function nestedGroupPath(levels: number): string {
  const segments = Array.from(
    { length: levels },
    (_unused, index) => `platform-engineering-group-${index}`,
  );
  return [...segments, 'payments-service'].join('/');
}

function mergeRequestRow(projectPath: string): Readonly<Record<string, unknown>> {
  return {
    id: 1,
    iid: 7,
    project_id: 3,
    title: 'Consolidate the duplicated normalizer',
    state: 'opened',
    references: { full: `${projectPath}!7` },
    web_url: `https://gitlab.com/${projectPath}/-/merge_requests/7`,
    updated_at: '2026-08-01T10:00:00Z',
    created_at: '2026-07-30T10:00:00Z',
  };
}

function projectRow(projectPath: string) {
  const decoded = decodeGitlabRow({
    kindId: 'merge-request',
    origin: GITLAB_COM,
    row: mergeRequestRow(projectPath),
    laneInvolvement: 'author',
  });
  if (decoded.kind !== 'mapped') throw new Error(decoded.reason);
  return projectGitlabPresentObservation(decoded.entry);
}

describe('projectGitlabPresentObservation locator bounds', () => {
  it('parses through the closed scan observation schema for an ordinary nested group', () => {
    const observation = projectRow('example-group/example-subgroup/example-project');

    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    expect(observation.locator.routingToken)
      .toBe('example-group/example-subgroup/example-project');
    expect(observation.locator.displayPath)
      .toBe('example-group/example-subgroup/example-project!7');
    expect(observation.locator.webUrl)
      .toBe('https://gitlab.com/example-group/example-subgroup/example-project/-/merge_requests/7');
    expect(observation.snapshot.projectionTruncated).toBeUndefined();
  });

  it('keeps a deeply nested merge request instead of rejecting the page it arrived on', () => {
    // Twenty group levels is GitLab's own documented nesting ceiling, not an invented one.
    const observation = projectRow(nestedGroupPath(20));

    // The whole result is what the strict target rejects atomically, so the row surviving
    // is the contract: one deep namespace must not discard every sibling row on the page.
    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    expect(observation.localRef.entryId).toBe('7');
    // A route and a URL are machine-meaningful: a shortened one addresses somewhere else,
    // so they are omitted rather than cut, and the omission is announced.
    expect(observation.locator.routingToken).toBeUndefined();
    expect(observation.locator.webUrl).toBeUndefined();
    // Display text is shortened rather than dropped: the row still reads as itself.
    expect(observation.locator.displayPath).not.toBeUndefined();
    expect(observation.snapshot.projectionTruncated).toBe(true);
  });

  it('omits only the route when the display path and URL still fit', () => {
    const observation = projectRow(nestedGroupPath(7));

    expect(TriageSourceScanObservationV1Schema.parse(observation)).toEqual(observation);
    expect(observation.locator.routingToken).toBeUndefined();
    expect(observation.locator.webUrl).not.toBeUndefined();
    expect(observation.locator.displayPath).toBe(`${nestedGroupPath(7)}!7`);
    expect(observation.snapshot.projectionTruncated).toBe(true);
  });
});
