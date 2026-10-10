import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import {
  projectTriageEntryDisplay,
  readTriageEntryRowAnnouncementV1,
} from './entryDisplay.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

function entryRef(input: Readonly<{ entryId?: string; collisionScope?: string }> = {}) {
  return {
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: input.collisionScope ?? 'origin',
    entryId: input.entryId ?? '42',
  } as const;
}

function present(input: Readonly<{
  sourceInstanceId: string;
  title: string;
  observedAtMs: number;
  scopeLabel?: string;
}>): ProjectedObservationV1 {
  return {
    sourceInstanceId: input.sourceInstanceId,
    observedAtMs: input.observedAtMs,
    outcome: {
      kind: 'present',
      locator: testkitLocator(),
      snapshot: testkitSnapshot({
        title: input.title,
        ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
      }),
      viewer: testkitViewer(),
    },
  };
}

/**
 * The row's `content` is the fold's own decision, so a fixture that carried
 * observations without one would be a row no fold can produce. It defaults to
 * the first present observation this row carries.
 */
function contentOf(observations: readonly ProjectedObservationV1[]): TriageListRowV1['content'] {
  for (const observation of observations) {
    if (observation.outcome.kind !== 'present') continue;
    return {
      sourceInstanceId: observation.sourceInstanceId,
      observedAtMs: observation.observedAtMs,
      outcome: observation.outcome,
    };
  }
  return null;
}

function row(input: Partial<TriageListRowV1> = {}): TriageListRowV1 {
  const observations = input.observations
    ?? [present({ sourceInstanceId: INSTANCE_A, title: 'A title', observedAtMs: 1_000 })];
  return {
    entryRef: entryRef(),
    content: contentOf(observations),
    lane: CORPUS_LANE.open,
    sortAtMs: 1_000,
    presence: { kind: 'present', observedAtMs: 1_000 },
    attention: null,
    selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
    ...input,
    observations,
  };
}

describe('projectTriageEntryDisplay', () => {
  it('retains the source-owned display path without parsing opaque identity or routing data', () => {
    const observation = present({ sourceInstanceId: INSTANCE_A, title: 'Same title', observedAtMs: 1_000 });
    if (observation.outcome.kind !== 'present') throw new Error('Expected present fixture');
    const projected = row({ content: {
      sourceInstanceId: INSTANCE_A,
      observedAtMs: 1_000,
      outcome: { ...observation.outcome, locator: {
        ...testkitLocator(), displayPath: 'example/repository#17', routingToken: 'opaque-not-for-display',
      } },
    } });
    expect(projectTriageEntryDisplay(projected).identifierLabel).toBe('example/repository#17');
  });
  it('shows the content observation the fold chose, never a winner of its own', () => {
    // Two connections observe the same entry with different titles, and the
    // mirror answered last. The fold decided once which observation speaks for
    // the row (`core/CORPUS.md` §3.2); re-deciding here is how a row's title
    // came to disagree with the lane the same row was filed under. The selected
    // connection is deliberately the other one: selection routes detail and
    // Actions (§3.6) and never re-decides content.
    const canonical = present({ sourceInstanceId: INSTANCE_A, title: 'Canonical copy', observedAtMs: 1_000 });
    const display = projectTriageEntryDisplay(row({
      selected: { kind: 'selected', sourceInstanceId: INSTANCE_B, reason: 'attention' },
      observations: [
        present({ sourceInstanceId: INSTANCE_B, title: 'Mirror copy', observedAtMs: 9_000 }),
        canonical,
      ],
      content: contentOf([canonical]),
    }));

    expect(display.title).toBe('Canonical copy');
  });

  it('still names an entry whose every observing connection has retired', () => {
    const display = projectTriageEntryDisplay(row({
      selected: { kind: 'none', reason: 'allInstancesRetired' },
      observations: [present({
        sourceInstanceId: INSTANCE_B,
        title: 'Retired but real',
        observedAtMs: 5_000,
      })],
    }));

    expect(display.title).toBe('Retired but real');
  });

  it('says why a row cannot be shown instead of quietly losing it', () => {
    const absent = projectTriageEntryDisplay(row({
      presence: { kind: 'absent', observedAtMs: 2_000 },
      selected: { kind: 'none', reason: 'noPresentObservation' },
      observations: [{
        sourceInstanceId: INSTANCE_A,
        observedAtMs: 2_000,
        outcome: { kind: 'absent' },
      }],
    }));

    expect(absent.detail).toBe('No longer reported by the source');
    expect(absent.tone).toBe('danger');
    // With no present observation anywhere, the canonical reference is the only
    // true thing left to show.
    expect(absent.title).toBe('42');
  });

  it('does not advertise attention over an entry the source no longer reports', () => {
    const display = projectTriageEntryDisplay(row({
      presence: { kind: 'unresolved', observedAtMs: 2_000 },
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    expect(display.detail).toBe('Could not be read in the last pass');
  });

  it('shows the attention reason on a present row', () => {
    const display = projectTriageEntryDisplay(row({
      observations: [present({
        sourceInstanceId: INSTANCE_A,
        title: 'A title',
        observedAtMs: 1_000,
      })],
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    expect(display.detail).toBe('Your review was requested');
    expect(display.summary).toBeNull();
    expect(display.tone).toBe('neutral');
  });

  it('carries the reason\'s icon and who opened the entry, saying "You" when the reader did', () => {
    const attention = {
      level: 'required' as const,
      fromSourceInstanceId: INSTANCE_A,
      reasonId: 'involvement/review-requested',
      reasonLabel: 'Your review was requested',
    };
    const byMara: ProjectedObservationV1 = {
      sourceInstanceId: INSTANCE_A,
      observedAtMs: 1_000,
      outcome: {
        kind: 'present',
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ authorLabel: 'Mara Oduya', designation: '#2481' }),
        viewer: testkitViewer(),
      },
    };
    const display = projectTriageEntryDisplay(row({ observations: [byMara], attention }));
    expect(display.detailIcon).toBe('review');
    expect(display.authorLabel).toBe('Mara Oduya');
    expect(display.designation).toBe('#2481');

    const mine: ProjectedObservationV1 = {
      ...byMara,
      outcome: { ...byMara.outcome, viewer: testkitViewer({ involvement: ['author'] }) } as ProjectedObservationV1['outcome'],
    };
    expect(projectTriageEntryDisplay(row({ observations: [mine] })).authorLabel).toBe('You');
    // No author reported and not the reader's: nothing is claimed.
    const display2 = projectTriageEntryDisplay(row());
    expect(display2.authorLabel).toBeNull();
    expect(display2.detailIcon).toBeNull();
    expect(display2.designation).toBeNull();
  });

  /**
   * `core/SURFACE.md` §7.1 requires a row to announce its kind, its lifecycle
   * and its freshness state — none of which the row's visible slots carry,
   * because a sighted reader reads them from the section it is filed under, its
   * icon and the page's own freshness line. A reader moving row by row has none
   * of that, so the facts travel on the one shared projection instead of being
   * inferred a second time by the shell and the picker.
   */
  it('carries the canonical kind and lifecycle facts an announcement needs', () => {
    const display = projectTriageEntryDisplay(row());

    expect(display.kindId).toBe('pull-request');
    // The provider's own word for the state, preserved: the closed presentation
    // enum is a lossy projection of it.
    expect(display.lifecycleLabel).toBe('Open');
    expect(display.observedAtMs).toBe(1_000);
  });

  it('falls back to the closed lifecycle vocabulary when a source named no word', () => {
    const display = projectTriageEntryDisplay(row({
      observations: [{
        sourceInstanceId: INSTANCE_A,
        observedAtMs: 1_000,
        outcome: {
          kind: 'present',
          locator: testkitLocator(),
          snapshot: testkitSnapshot({ state: { presentation: 'resolved' } }),
          viewer: testkitViewer(),
        },
      }],
    }));

    expect(display.lifecycleLabel).toBe('Resolved');
  });

  it('resolves its own presence sentences through the plugin catalog', () => {
    // These are product-authored words, not provider text: shipping them as
    // hardcoded English made two surfaces announce English on every locale.
    const german = (key: string, fallback = ''): string => (
      key === 'plugins.triage.surface.row.absent' ? 'Von der Quelle nicht mehr gemeldet' : fallback
    );
    const display = projectTriageEntryDisplay(row({
      presence: { kind: 'absent', observedAtMs: 2_000 },
      selected: { kind: 'none', reason: 'noPresentObservation' },
      observations: [{
        sourceInstanceId: INSTANCE_A,
        observedAtMs: 2_000,
        outcome: { kind: 'absent' },
      }],
    }), german);

    expect(display.detail).toBe('Von der Quelle nicht mehr gemeldet');
  });
});

describe('what a reader who cannot see a row is told about it', () => {
  const NOW_MS = 1_760_000_000_000;

  it('announces kind, scope, lifecycle and reason, and never repeats the title', () => {
    const display = projectTriageEntryDisplay(row({
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    const announcement = readTriageEntryRowAnnouncementV1({
      ...display,
      stale: false,
    }, { nowMs: NOW_MS, locale: 'en' });

    expect(announcement).toBe(
      'pull-request, example/repository, Open, Your review was requested',
    );
    expect(announcement).not.toContain(display.title);
  });

  it('says the row\'s signal and linked agent state, which the table shows in their own cells', () => {
    const display = projectTriageEntryDisplay(row());
    const announcement = readTriageEntryRowAnnouncementV1({
      ...display,
      stale: false,
      signalLabel: '2 failing',
      agentLabel: 'Needs your permission',
    }, { nowMs: NOW_MS, locale: 'en' });

    expect(announcement).toBe('pull-request, example/repository, Open, 2 failing, Needs your permission');
  });

  it('says a retained row is stale and when it was last observed', () => {
    // The rows of a window whose refresh failed are still on screen, and the
    // page says so once. A reader walking rows never reaches that sentence, so
    // without this a retained row is indistinguishable from a current one.
    const display = projectTriageEntryDisplay(row({
      presence: { kind: 'present', observedAtMs: NOW_MS - 240_000 },
      observations: [present({
        sourceInstanceId: INSTANCE_A,
        title: 'A title',
        observedAtMs: NOW_MS - 240_000,
      })],
    }));

    const announcement = readTriageEntryRowAnnouncementV1({
      ...display,
      stale: true,
    }, { nowMs: NOW_MS, locale: 'en' });

    expect(announcement).toContain('Stale, last seen');
    expect(announcement).toContain('4 minutes ago');
  });

  it('makes no freshness claim about a row the window still calls current', () => {
    const display = projectTriageEntryDisplay(row());
    const announcement = readTriageEntryRowAnnouncementV1({
      ...display,
      stale: false,
    }, { nowMs: NOW_MS, locale: 'en' });

    expect(announcement).not.toContain('Stale');
  });

  it('says stale without inventing an age it does not know', () => {
    const display = projectTriageEntryDisplay(row({
      presence: { kind: 'unresolved', observedAtMs: null },
      selected: { kind: 'none', reason: 'noPresentObservation' },
      observations: [{
        sourceInstanceId: INSTANCE_A,
        observedAtMs: 3_000,
        outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'busy' } },
      }],
    }));

    const announcement = readTriageEntryRowAnnouncementV1({
      ...display,
      observedAtMs: null,
      stale: true,
    }, { nowMs: NOW_MS, locale: 'en' });

    expect(announcement).toContain('Could not be read in the last pass');
    expect(announcement).toContain('Stale');
    expect(announcement).not.toContain('last seen');
  });
});
