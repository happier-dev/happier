import type { PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';
import {
  CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
  CURRENT_UI_CONTEXT_MAX_COMMANDS_V1,
  CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1,
} from '@happier-dev/plugin-sdk/ui';
import { PluginUiContextEnrichmentV1Schema } from '@happier-dev/protocol';
import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../corpus/fold/lane.js';
import type { ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import type { TriageListRowV1 } from '../projection/listWindow.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../composer/openEntryDetails.js';
import { parseTriageRouteSubPathV1 } from './navigation/location.js';
import {
  TRIAGE_SURFACE_INITIAL_STATE_V1,
  reduceTriageSurfaceV1,
  type TriageSurfaceStateV1,
} from './state/surface.js';
import { projectTriageCurrentUiContextV1 } from './currentContext.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111' as TriageSourceInstanceIdV1;

function entryRef(entryId: string, overrides: Partial<TriageEntryRefV1> = {}): TriageEntryRefV1 {
  return {
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'acme/widgets',
    entryId,
    ...overrides,
  };
}

function present(input: Readonly<{
  entryId: string;
  title?: string;
  summary?: string;
  scopeLabel?: string;
  secretLocator?: string;
}>): ProjectedObservationV1 {
  return {
    sourceInstanceId: INSTANCE,
    observedAtMs: 1_000,
    outcome: {
      kind: 'present',
      locator: testkitLocator(input.secretLocator === undefined ? {} : {
        webUrl: input.secretLocator,
        routingToken: input.secretLocator,
      }),
      snapshot: testkitSnapshot({
        title: input.title ?? `Entry ${input.entryId}`,
        scopeLabel: input.scopeLabel ?? 'acme/widgets',
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }),
      viewer: testkitViewer(),
    },
  };
}

function row(input: Parameters<typeof present>[0]): TriageListRowV1 {
  const observation = present(input);
  if (observation.outcome.kind !== 'present') throw new Error('fixture must be present');
  return {
    entryRef: entryRef(input.entryId),
    content: {
      sourceInstanceId: INSTANCE,
      observedAtMs: observation.observedAtMs,
      outcome: observation.outcome,
    },
    lane: CORPUS_LANE.open,
    sortAtMs: observation.observedAtMs,
    presence: { kind: 'present', observedAtMs: observation.observedAtMs },
    attention: null,
    selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
    observations: [observation],
  };
}

function selected(
  entryId: string,
  focusedEntryId: string | null = null,
): TriageSurfaceStateV1 {
  const detail = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
    kind: 'rowActivated',
    sectionId: 'open',
    entryRef: entryRef(entryId),
    sourceInstanceId: INSTANCE,
  });
  return focusedEntryId === null ? detail : reduceTriageSurfaceV1(detail, {
    kind: 'rowFocused',
    sectionId: 'done',
    entryRef: entryRef(focusedEntryId),
  });
}

function openSurfaceCommands(context: PluginUiContextEnrichmentV1) {
  return context.commands?.map((declaration) => {
    if (declaration.command.kind !== 'openSurface') throw new Error('expected openSurface command');
    return declaration;
  }) ?? [];
}

describe('Triage current UI context projection', () => {
  it('keeps empty and retained-missing selections truthful', () => {
    const empty = projectTriageCurrentUiContextV1({
      surface: TRIAGE_SURFACE_INITIAL_STATE_V1,
      visibleRows: [],
    });
    expect(empty).toEqual({ detail: { view: 'list' }, commands: [] });
    expect(PluginUiContextEnrichmentV1Schema.safeParse(empty).success).toBe(true);

    const directLaunch = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'rowActivated',
      sectionId: null,
      entryRef: entryRef('A'),
      sourceInstanceId: INSTANCE,
    });
    const missing = projectTriageCurrentUiContextV1({
      surface: directLaunch,
      visibleRows: [],
    });
    expect(missing.entity).toEqual({
      kind: 'pull-request',
      // This is the reference-derived fallback, not a remembered or invented
      // display title. The direct-launch lens has no row for A.
      label: 'pull-request A',
      reference: entryRef('A'),
    });
    expect(missing.entity).not.toHaveProperty('summary');
    expect(missing.detail).toEqual({ view: 'selected-detail', incomplete: true });
    expect(missing.commands).toEqual([]);
    expect(PluginUiContextEnrichmentV1Schema.safeParse(missing).success).toBe(true);

    // A current, mounted sibling remains a current command. Returning early
    // with the fallback would incorrectly hide that existing route action.
    const withCurrentSibling = projectTriageCurrentUiContextV1({
      surface: directLaunch,
      visibleRows: [row({ entryId: 'B', title: 'Issue B' })],
    });
    expect(withCurrentSibling.entity).toEqual(missing.entity);
    expect(withCurrentSibling.detail).toEqual({ view: 'selected-detail', incomplete: true });
    const commands = openSurfaceCommands(withCurrentSibling);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      title: 'Open Issue B',
      command: {
        kind: 'openSurface',
        destination: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
      },
    });
    const command = commands[0]?.command;
    if (command?.kind !== 'openSurface') throw new Error('expected command');
    expect(parseTriageRouteSubPathV1(command.subPath).selection).toEqual(entryRef('B'));
  });

  it('discloses that the entries it publishes are a narrowed set', () => {
    const issueA = row({ entryId: 'A', title: 'Canonical issue A' });

    // A reading agent sees exactly the rows the reader's lens left. Publishing
    // them with nothing saying so is the same failure as a bare count beside a
    // filtered list: the set agrees with itself, and neither the agent nor the
    // reader can tell it apart from the whole list.
    const narrowed = projectTriageCurrentUiContextV1({
      surface: reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
        kind: 'searchChanged',
        query: 'parser',
      }),
      visibleRows: [issueA],
    });
    expect(narrowed.detail).toEqual({ view: 'list', filtered: true });
    expect(PluginUiContextEnrichmentV1Schema.safeParse(narrowed).success).toBe(true);

    // A facet is the other half of the same disclosure, and it survives into
    // the detail view because the published commands are still the narrowed set.
    const facetNarrowed = projectTriageCurrentUiContextV1({
      surface: reduceTriageSurfaceV1(selected('A'), {
        kind: 'filterValueToggled',
        facet: 'states',
        value: 'done',
      }),
      visibleRows: [issueA],
    });
    expect(facetNarrowed.detail).toMatchObject({ view: 'selected-detail', filtered: true });

    // A query the one search owner reads no term out of narrows nothing, so
    // claiming it here would be the same lie in the other direction.
    const untouched = projectTriageCurrentUiContextV1({
      surface: reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
        kind: 'searchChanged',
        query: '   ',
      }),
      visibleRows: [issueA],
    });
    expect(untouched.detail).toEqual({ view: 'list' });
  });

  it('distinguishes the list from selected detail and exposes only the canonical selected display', () => {
    const issueA = row({
      entryId: 'A',
      title: 'Canonical issue A',
      scopeLabel: 'acme/widgets',
      summary: 'Bounded issue summary',
    });

    expect(projectTriageCurrentUiContextV1({
      surface: TRIAGE_SURFACE_INITIAL_STATE_V1,
      visibleRows: [issueA],
    })).toMatchObject({ detail: { view: 'list' } });

    expect(projectTriageCurrentUiContextV1({
      surface: selected('A'),
      visibleRows: [issueA],
    })).toMatchObject({
      entity: {
        kind: 'pull-request',
        label: 'Canonical issue A',
        summary: 'Bounded issue summary',
        reference: entryRef('A'),
      },
      detail: { view: 'selected-detail', scopeLabel: 'acme/widgets' },
    });
  });

  it('reads selection rather than a keyboard focus parked on another row', () => {
    const issueA = {
      ...row({ entryId: 'A', title: 'Selected issue A', summary: 'Canonical bounded summary' }),
      attention: {
        level: 'required' as const,
        fromSourceInstanceId: INSTANCE,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    };
    const issueB = row({ entryId: 'B', title: 'Focused issue B' });

    const context = projectTriageCurrentUiContextV1({
      surface: selected('A', 'B'),
      visibleRows: [issueA, issueB],
    });

    expect(context.entity?.label).toBe('Selected issue A');
    expect(context.entity?.summary).toBe('Canonical bounded summary');
    expect(context.entity?.reference).toEqual(entryRef('A'));
  });

  it('opens neighboring visible materialized entries through the existing destination and current lens', () => {
    const issueA = row({ entryId: 'A', title: 'Issue A' });
    const issueB = row({ entryId: 'B', title: 'Issue B' });
    const context = projectTriageCurrentUiContextV1({
      surface: selected('A'),
      visibleRows: [issueB, issueA],
    });

    const commands = openSurfaceCommands(context);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      title: 'Open Issue B',
      command: {
        kind: 'openSurface',
        destination: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
      },
    });
    const command = commands[0]?.command;
    if (command?.kind !== 'openSurface') throw new Error('expected command');
    expect(parseTriageRouteSubPathV1(command.subPath).selection).toEqual(entryRef('B'));
  });

  it('replaces issue A with B and offers only the now-neighboring A command', () => {
    const issueA = row({ entryId: 'A', title: 'Issue A' });
    const issueB = row({ entryId: 'B', title: 'Issue B' });

    const context = projectTriageCurrentUiContextV1({
      surface: selected('B'),
      visibleRows: [issueA, issueB],
    });

    expect(context.entity?.reference).toEqual(entryRef('B'));
    const commands = openSurfaceCommands(context);
    expect(commands.map((command) => command.title)).toEqual(['Open Issue A']);
    const command = commands[0]?.command;
    if (command?.kind !== 'openSurface') throw new Error('expected command');
    expect(parseTriageRouteSubPathV1(command.subPath).selection).toEqual(entryRef('A'));
  });

  it('orders eligible commands canonically and reports bounded omissions explicitly', () => {
    const rows = Array.from({ length: 40 }, (_, index) => row({
      entryId: String(40 - index).padStart(2, '0'),
      title: `Issue ${'x'.repeat(300)} ${index}`,
    }));

    const context = projectTriageCurrentUiContextV1({
      surface: TRIAGE_SURFACE_INITIAL_STATE_V1,
      visibleRows: rows,
    });
    const commands = openSurfaceCommands(context);
    const commandEntryIds = commands.map((declaration) => {
      const command = declaration.command;
      if (command.kind !== 'openSurface') throw new Error('expected command');
      return parseTriageRouteSubPathV1(command.subPath).selection?.entryId;
    });

    expect(commands.length).toBeLessThanOrEqual(CURRENT_UI_CONTEXT_MAX_COMMANDS_V1);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength)
      .toBeLessThanOrEqual(CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1);
    expect(PluginUiContextEnrichmentV1Schema.safeParse(context).success).toBe(true);
    expect(context.detail).toMatchObject(CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1);
    expect(commandEntryIds).toEqual([...commandEntryIds].sort());
  });

  it('does not project provider locators, credentials, body, comments, checks, files, or session internals', () => {
    const secret = 'https://forge.invalid/private?token=super-secret';
    const issueA = row({
      entryId: 'A',
      title: 'Issue A',
      summary: 'Safe bounded summary',
      secretLocator: secret,
    });
    const context = projectTriageCurrentUiContextV1({
      surface: selected('A'),
      visibleRows: [issueA],
    });
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/routingToken|webUrl|body|comments|checks|files|credential|session/iu);
  });
});
