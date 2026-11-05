import {
  MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TriageDetailSurfaceInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import { PluginUiLaunchInputV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import { PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/plugins/ui/semanticCommands';

import type { GithubApiClientV1 } from '../../../../scm-github/src/observations/githubApiClient.js';

import { buildTriageDetailSurfaceInputV1 } from './input.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';

const FIXTURE = createTriageSourceV1Fixture();
const INSTANCE = FIXTURE.configuredInstance;
const OBSERVATION = FIXTURE.detailInput.observation;

const SELECTION: TriageSurfaceSelectionV1 = {
  sectionId: '2-open',
  entryRef: OBSERVATION.entryRef,
  sourceInstanceId: INSTANCE.instance.sourceInstanceId,
};

function build(overrides: Partial<Parameters<typeof buildTriageDetailSurfaceInputV1>[0]> = {}) {
  return buildTriageDetailSurfaceInputV1({
    selection: SELECTION,
    instance: INSTANCE,
    observation: OBSERVATION,
    linkedSessions: FIXTURE.detailInput.linkedSessions,
    linkedSessionsHasMore: false,
    ...overrides,
  });
}

describe('Triage detail surface input', () => {
  it('fits source-produced relationships at physical launch admission, retaining their summary', async () => {
    const [{ readGithubIssueRelations }, { createGithubRepositoryReader }, {
      GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE,
    }] = await Promise.all([
      import('../../../../scm-github/src/triage/relations.js'),
      import('../../../../scm-github/src/triage/repositories.js'),
      import('../../../../scm-github/src/triage/__fixtures__/githubResponses.js'),
    ]);
    const client: GithubApiClientV1 = {
      request: async ({ url }) => ({
        status: url.endsWith('/parent') ? 404 : 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify(url.endsWith('/example-tools')
          ? GITHUB_OTHER_REPOSITORY_RESPONSE
          : url.endsWith('/parent') ? {} : Array.from({ length: 100 }, (_, index) => ({
            ...GITHUB_ISSUE_RESPONSE,
            number: index + 1,
            url: `https://api.github.com/repos/octo-org/example-tools/issues/${index + 1}`,
            html_url: `https://github.com/octo-org/example-tools/issues/${index + 1}`,
            state: index < 20 ? 'closed' : 'open',
          })))),
      }),
      requestWithoutFollowingRedirects: async () => { throw new Error('unexpected redirect'); },
    };
    const relations = await readGithubIssueRelations(
      { kindId: 'issue', collisionScope: 'github:8815', entryId: '42' },
      { owner: 'octo-org', name: 'example-tools' },
      createGithubRepositoryReader({ client, now: () => 0 }),
      {
        now: () => 0,
        signal: new AbortController().signal,
        client,
      },
    );
    expect(relations?.children).toMatchObject({ total: 100, completed: 20, complete: true });
    const observation = { ...OBSERVATION, snapshot: { ...OBSERVATION.snapshot, relations } };
    expect(TriageDetailSurfaceInputV1Schema.safeParse({
      ...FIXTURE.detailInput, observation,
    }).success).toBe(true);
    const built = build({ observation });
    expect(built.kind).toBe('admitted');
    if (built.kind !== 'admitted') throw new Error('expected admitted source detail');
    expect(PluginUiLaunchInputV1Schema.safeParse(built.input).success).toBe(true);
    expect(built.input.observation.snapshot).toMatchObject({
      projectionTruncated: true,
      relations: { children: { total: 100, completed: 20 } },
    });
    expect(built.input.observation.snapshot.relations?.children?.complete).toBeUndefined();
    expect(observation.snapshot.relations?.children?.entries).toHaveLength(100);
  });

  it('fits linked Sessions by bytes and marks the retained prefix incomplete', () => {
    // Each title fits beside the detail envelope, while the full page exceeds the host's launch budget.
    const titleBytes = Math.min(MAX_TRIAGE_TEXT_UTF8_BYTES_V1, PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 / 2);
    const linkedSessions = Array.from({ length: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 }, (_, index) => ({
      sessionId: `session-${index}`,
      displayTitle: '🦊'.repeat(Math.floor(titleBytes / 4)),
    }));
    const built = build({ linkedSessions });
    expect(built.kind).toBe('admitted');
    if (built.kind !== 'admitted') throw new Error('expected admitted source detail');
    expect(PluginUiLaunchInputV1Schema.safeParse(built.input).success).toBe(true);
    expect(built.input.linkedSessionsHasMore).toBe(true);
    expect(built.input.linkedSessions.length).toBeGreaterThan(0);
    expect(built.input.linkedSessions.length).toBeLessThan(linkedSessions.length);
    expect(built.input.linkedSessions).toEqual(linkedSessions.slice(0, built.input.linkedSessions.length));
    // A short title permits more links: this is the physical byte boundary,
    // not a new semantic Session-count cap.
    const short = build({ linkedSessions: linkedSessions.map(({ sessionId }) => ({ sessionId })) });
    expect(short.kind === 'admitted' && short.input.linkedSessions).toHaveLength(linkedSessions.length);
    expect(short.kind === 'admitted' && short.input.linkedSessionsHasMore).toBe(false);
  });

  it('includes the actual source panel in the same launch admission', () => {
    const built = build({
      linkedSessions: Array.from({ length: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 }, (_, index) => ({
        sessionId: `session-${index}`, displayTitle: 'a'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1),
      })),
      panel: 'stack-trace',
    });
    expect(built.kind).toBe('admitted');
    if (built.kind !== 'admitted') throw new Error('expected admitted source panel');
    expect(built.input.panel).toBe('stack-trace');
    expect(PluginUiLaunchInputV1Schema.safeParse(built.input).success).toBe(true);
  });

  it('keeps editable-field summaries when a source workflow needs a live detail read', () => {
    const taskCapabilities = {
      editFields: ['title'] as const,
      transitions: Array.from({ length: 100 }, (_, index) => ({
        id: `workflow-${index}`, label: 'Native workflow transition '.repeat(10),
        state: { presentation: 'active' as const },
      })),
    };
    const built = build({ observation: {
      ...OBSERVATION, snapshot: { ...OBSERVATION.snapshot, taskCapabilities },
    } });
    expect(built.kind).toBe('admitted');
    if (built.kind !== 'admitted') throw new Error('expected admitted workflow detail');
    expect(PluginUiLaunchInputV1Schema.safeParse(built.input).success).toBe(true);
    expect(built.input.observation.snapshot.projectionTruncated).toBe(true);
    expect(built.input.observation.snapshot.taskCapabilities?.editFields).toEqual(['title']);
    expect(built.input.observation.snapshot.taskCapabilities?.transitions).toBeUndefined();
    expect(taskCapabilities.transitions).toHaveLength(100);
  });

  it('admits the exact closed contract value the source detail renderer receives', () => {
    const built = build();

    expect(built.kind).toBe('admitted');
    // Parsing back through the published schema is what proves no aggregate
    // freshness field, refresh marker, credential, DTO, registry, callback or
    // renderer id rode along: the object is closed.
    expect(built.kind === 'admitted' && TriageDetailSurfaceInputV1Schema.parse(built.input))
      .toEqual(built.kind === 'admitted' ? built.input : null);
    expect(built.kind === 'admitted' && Object.keys(built.input).sort())
      .toEqual(['instance', 'linkedSessions', 'linkedSessionsHasMore', 'observation', 'v']);
  });

  it('refuses an observation for a different entry than the one the user selected', () => {
    const otherEntry = { ...OBSERVATION, entryRef: { ...OBSERVATION.entryRef, entryId: '999' } };

    // Rendering a source body for an entry the row never named is the silent
    // wrong-detail failure this boundary exists to stop.
    expect(build({ observation: otherEntry })).toEqual({
      kind: 'refused',
      reason: 'entryMismatch',
    });
  });

  it('refuses source-only repository data inside the closed mounted observation', () => {
    const observationWithRepository = {
      ...OBSERVATION,
      repository: {
        kind: 'github',
        deployment: 'https://example.test',
        repository: 'example/repository',
      },
    } as typeof OBSERVATION;

    // Repository identity is launch input owned by the aggregate host. A source
    // detail receives the published closed observation and no extra host facts;
    // nesting this sibling here is the mounted-read rejection this regression
    // guards.
    expect(build({ observation: observationWithRepository })).toEqual({
      kind: 'refused',
      reason: 'invalidContractValue',
    });
  });

  it('refuses an instance that is not the selected observing connection', () => {
    const otherInstance = {
      ...INSTANCE,
      instance: {
        ...INSTANCE.instance,
        sourceInstanceId: '9f0d4ab7-6c4a-4f9d-9b2e-0f1a2b3c4d5e',
      },
    };

    expect(build({ instance: otherInstance })).toEqual({
      kind: 'refused',
      reason: 'instanceMismatch',
    });
  });

  it('refuses an instance contributed by a different source than the entry', () => {
    const foreignSource = {
      ...INSTANCE,
      instance: {
        ...INSTANCE.instance,
        source: { ...INSTANCE.instance.source, localId: 'other-forge' },
      },
    };

    // Same stable id under a different admitted contribution would mount one
    // source's renderer against another source's entry.
    expect(build({ instance: foreignSource })).toEqual({
      kind: 'refused',
      reason: 'instanceMismatch',
    });
  });

  it('fits a complete source-owned linked-Session read into the existing launch projection', () => {
    // Derived from the published bound, never retyped: the count that is
    // over-bound moves whenever the projection is re-derived, and a literal here
    // silently stops testing anything the day the bound is raised past it.
    const tooMany = Array.from({ length: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1 }, (_unused, index) => ({
      sessionId: `session-${index}`,
    }));

    const built = build({ linkedSessions: tooMany });

    expect(built.kind).toBe('admitted');
    expect(built.kind === 'admitted' && built.input.linkedSessions).toEqual(tooMany.slice(0, MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1));
    expect(built.kind === 'admitted' && built.input.linkedSessionsHasMore).toBe(true);
  });

  it.each([undefined, false, true])('preserves empty linked-Session completeness (%s)', (linkedSessionsHasMore) => {
    const built = build({ linkedSessions: [], linkedSessionsHasMore });

    expect(built.kind === 'admitted' && built.input.linkedSessions).toEqual([]);
    expect(built.kind === 'admitted' && built.input.linkedSessionsHasMore).toBe(linkedSessionsHasMore === true);
  });
});
