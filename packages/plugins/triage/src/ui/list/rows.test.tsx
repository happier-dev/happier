import { describe, expect, it } from 'vitest';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import {
  planTriageListContinuationV1,
  readTriageWindowStatementV1,
} from './continuation.js';
import {
  TRIAGE_ROW_SELECT_ACTION_ID_V1,
  readTriageAgentBadgeV1,
  readTriageRowPlaceV1,
  readTriageAgentCellMarkV1,
  readTriageAttentionBadgeToneV1,
  readTriageRowMarkV1,
  readTriageSignalCellMarkV1,
  triageListRowItemProps,
  triageListRowSecondaryActionsV1,
  triageListRowTestId,
} from './rows.js';

/**
 * What this file decides is which already-projected word goes in which slot,
 * and which of them a reader who cannot see the row is told. Those are the
 * assertions here.
 *
 * The shared `List.Item` owns whether a description reaches the platform frame
 * and is proved where it lives (`plugin-ui` `List.rowDescription.native`); it
 * cannot be re-proved from this package, because the mounted surface harness
 * every other Triage UI test uses is react-native-web, which forwards no
 * accessible description at all.
 */

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;

function displayRow(
  overrides: Partial<TriageListDisplayRowV1> = {},
): TriageListDisplayRowV1 {
  return {
    key: 'happier.forge/items|pull-request|origin|31',
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId: '31' },
    title: 'Replace the duplicated normalizer',
    scopeLabel: 'example/repository',
    detail: null,
    tone: 'neutral',
    detailKind: null,
    lifecyclePresentation: 'active',
    activityAtMs: null,
    pinned: false,
    materialized: true,
    sourceInstanceId: null,
    kindId: 'pull-request',
    lifecycleLabel: 'Open',
    observedAtMs: 1_000,
    stale: false,
    ...overrides,
  };
}

describe('a PRs & Issues entry row\u2019s secondary actions', () => {
  it('offers Select first, because it is the only way a finger reaches a bulk selection', () => {
    // A finger has no Command key. Without this affordance the whole
    // multi-selection capability \u2014 and the bulk bar, executor and three
    // destinations behind it \u2014 is desktop-only.
    const actions = triageListRowSecondaryActionsV1({
      selectLabel: 'Select Replace the duplicated normalizer',
      pinLabel: 'Pin Replace the duplicated normalizer',
      pinDisabled: false,
    });

    expect(actions.map((action) => action.id)).toEqual([
      TRIAGE_ROW_SELECT_ACTION_ID_V1,
      'set-pinned',
    ]);
  });

  it('never disables Select because the PIN store is unreachable', () => {
    // Pin needs the Account; choosing rows needs nothing but the list. Letting
    // an unreachable pin store take the selection affordance away would make a
    // reader who cannot pin unable to bulk-act either.
    const actions = triageListRowSecondaryActionsV1({
      selectLabel: 'Select it',
      pinLabel: 'Pin it',
      pinDisabled: true,
    });

    expect(actions[0]).toEqual({ id: TRIAGE_ROW_SELECT_ACTION_ID_V1, label: 'Select it' });
    expect(actions[1]?.disabled).toBe(true);
  });
});

/** The clock and locale every announcement below is stated against. */
const ANNOUNCED = Object.freeze({ nowMs: 1_760_000_000_000, locale: 'en' });

describe('a PRs & Issues entry row', () => {
  it('retains the source identity when its declared display name is unavailable', () => {
    const props = triageListRowItemProps(displayRow(), false, {
      ...ANNOUNCED, source: SOURCE, descriptor: null,
    });
    expect(props.subtitle).toContain('happier.forge/items');
  });
  it('visibly distinguishes same-title entries by declared source, kind, identifier and lifecycle', () => {
    const descriptor = {
      v: 1 as const,
      purpose: 'triage-source',
      displayName: 'Example forge',
      kinds: [
        { id: 'pull-request', workflowSubject: 'pullRequest' as const, displayName: 'Pull request' },
        { id: 'issue', workflowSubject: 'issue' as const, displayName: 'Code issue' },
      ],
    };
    const first = triageListRowItemProps(displayRow({ identifierLabel: 'example/repository#31' }), false, {
      ...ANNOUNCED, descriptor,
    });
    const second = triageListRowItemProps(displayRow({
      kindId: 'issue',
      identifierLabel: 'example/repository#32',
      lifecycleLabel: 'Closed',
    }), false, { ...ANNOUNCED, descriptor });
    expect(first.title).toBe(second.title);
    expect(first.subtitle).toContain('Example forge');
    expect(first.subtitle).toContain('Pull request');
    expect(first.subtitle).toContain('example/repository#31');
    expect(first.subtitle).toContain('Open');
    expect(second.subtitle).toContain('Code issue');
    expect(second.subtitle).toContain('example/repository#32');
    expect(second.subtitle).toContain('Closed');
    expect(first.accessibilityHint).toContain('Pull request');
    expect(first.accessibilityHint).not.toContain('pull-request');
  });
  it('keeps the entry as its accessible name and says the rest beside it', () => {
    // `core/SURFACE.md` §7.1 requires the attention reason to be announced.
    // Pinning the name to the title is what stops the shared row composing
    // "Replace the duplicated normalizerexample/repository" — and it is also
    // what silenced every other word on the row until this description existed.
    const props = triageListRowItemProps(
      displayRow({ detail: 'Your review is requested' }),
      false,
      ANNOUNCED,
    );

    expect(props.accessibilityLabel).toBe('Replace the duplicated normalizer');
    // Kind and lifecycle are announced too: a reader moving row by row hears no
    // section heading and sees no state chip (`core/SURFACE.md` §7.1).
    expect(props.accessibilityHint)
      .toBe('pull-request, example/repository, Open, Your review is requested');
  });

  it('still names the owning scope when the row has nothing else to add', () => {
    // Two repositories routinely hold an entry with the same title, and the
    // name deliberately does not disambiguate them.
    expect(triageListRowItemProps(displayRow(), false, ANNOUNCED).accessibilityHint)
      .toBe('pull-request, example/repository, Open');
  });

  it('announces the freshness note of a pin this mount never materialized', () => {
    const props = triageListRowItemProps(
      displayRow({
        detail: 'Not yet synchronized',
        materialized: false,
        pinned: true,
        // Nothing materialized this pin, so this mount knows no lifecycle and
        // no observation moment for it.
        lifecycleLabel: null,
        observedAtMs: null,
      }),
      false,
      ANNOUNCED,
    );

    expect(props.accessibilityHint).toBe('pull-request, example/repository, Not yet synchronized');
  });

  it('announces why an entry the source dropped is still listed', () => {
    // A presence note is the row's whole reason for looking different, and it
    // is stated in words rather than by tone alone (§7.1).
    const props = triageListRowItemProps(
      displayRow({
        detail: 'No longer reported by the source',
        tone: 'danger',
        detailKind: 'presence',
        lifecycleLabel: null,
      }),
      false,
      ANNOUNCED,
    );

    expect(props.accessibilityHint)
      .toBe('pull-request, example/repository, No longer reported by the source');
    // The caution lives on the note that states it; the title stays a title,
    // so a dropped row still reads as a row (DESIGN-SPEC §5.5).
    expect(props.detailTone).toBe('danger');
    expect(props).not.toHaveProperty('tone');
  });

  it('never repeats the entry it has already been named after', () => {
    // A description that restates the name makes every row announce itself
    // twice, which is the failure the pinned name exists to prevent.
    const props = triageListRowItemProps(
      displayRow({ detail: 'Your review is requested' }),
      false,
      ANNOUNCED,
    );

    expect(props.accessibilityHint).not.toContain('Replace the duplicated normalizer');
  });

  it('shows the same words it announces, in the same order', () => {
    // The description is the row's own visible content, not a second copy that
    // can drift from it. Nothing is announced that the row does not display.
    const props = triageListRowItemProps(
      displayRow({ detail: 'Your review is requested', detailKind: 'attention' }),
      true,
      ANNOUNCED,
    );

    expect(props).toEqual({
      testID: triageListRowTestId('happier.forge/items|pull-request|origin|31'),
      title: 'Replace the duplicated normalizer',
      subtitle: 'pull-request · example/repository · Open',
      detail: 'Your review is requested',
      detailTone: 'attention',
      busy: true,
      accessibilityLabel: 'Replace the duplicated normalizer',
      accessibilityHint: 'pull-request, example/repository, Open, Your review is requested',
      // The row's own text is bounded, because the shared virtualizer has no
      // fixed row height and reveals an unmounted row by the measured average.
      // A provider title is a bounded 4 KiB string, not a bounded LINE COUNT:
      // one entry titled with a paragraph makes every scroll estimate on the
      // page describe a row that does not exist.
      titleNumberOfLines: 2,
      subtitleNumberOfLines: 1,
      detailNumberOfLines: 1,
    });
  });

  it('makes a required-attention reason the one loud fact and keeps a summary quiet', () => {
    const attention = triageListRowItemProps(
      displayRow({ detail: 'Your review is requested', detailKind: 'attention' }),
      false,
      ANNOUNCED,
    );
    const summary = triageListRowItemProps(
      displayRow({ detail: 'Adds retries to the fetcher', detailKind: 'summary' }),
      false,
      ANNOUNCED,
    );
    const suggestion = triageListRowItemProps(
      displayRow({ detail: 'You were mentioned', detailKind: 'suggestion' }),
      false,
      ANNOUNCED,
    );
    // Needs-you speaks the work status vocabulary's attention tone, never blue.
    expect(attention.detailTone).toBe('attention');
    expect(summary).not.toHaveProperty('detailTone');
    expect(suggestion).not.toHaveProperty('detailTone');
    expect(readTriageRowMarkV1(displayRow({ detailKind: 'attention' }))).toEqual({ name: 'change-open', tone: 'attention' });
    expect(readTriageRowMarkV1(displayRow({ lifecyclePresentation: 'resolved' }))).toEqual({ name: 'change-complete', tone: 'secondary' });
    expect(readTriageRowMarkV1(displayRow({ lifecyclePresentation: null, detailKind: 'presence', tone: 'warning' })))
      .toEqual({ name: 'info', tone: 'warning' });
    // The detail header's badge: a required reason needs you, a suggestion stays quiet (never blue).
    expect(readTriageAttentionBadgeToneV1('required')).toBe('attention');
    expect(readTriageAttentionBadgeToneV1('suggested')).toBe('secondary');
  });

  it('names the place alone once the designation is said beside the title, and the source address otherwise', () => {
    expect(readTriageRowPlaceV1({ designation: '#2481', identifierLabel: 'tidewater/payments-api#2481', scopeLabel: 'tidewater/payments-api' }))
      .toBe('tidewater/payments-api');
    expect(readTriageRowPlaceV1({ designation: null, identifierLabel: 'CHECKOUT-WEB', scopeLabel: 'checkout-web' }))
      .toBe('CHECKOUT-WEB');
  });

  it('badges the row glyph with what the linked agent is doing: a hand while it waits on the reader, a live dot while it works', () => {
    expect(readTriageAgentBadgeV1({ kind: 'permission', tone: 'attention', live: false })).toEqual({ mark: 'attention', tone: 'attention' });
    expect(readTriageAgentBadgeV1({ kind: 'input', tone: 'neutral', live: false })).toEqual({ mark: 'attention', tone: 'attention' });
    expect(readTriageAgentBadgeV1({ kind: 'working', tone: 'neutral', live: true })).toEqual({ mark: 'live' });
    expect(readTriageAgentBadgeV1({ kind: 'failed', tone: 'danger', live: false })).toEqual({ mark: 'error', tone: 'danger' });
    expect(readTriageAgentBadgeV1({ kind: 'ready', tone: 'neutral', live: false })).toEqual({ mark: 'check', tone: 'success' });
    // Offline or archived agents are history, not a state to badge.
    expect(readTriageAgentBadgeV1({ kind: 'offline', tone: 'attention', live: false })).toBeNull();
    expect(readTriageAgentBadgeV1({ kind: 'archived', tone: 'neutral', live: false })).toBeNull();
  });

  it('marks a cell only where it says something: healthy is quiet, news and working are ink, needs-you amber, failure rose', () => {
    expect(readTriageSignalCellMarkV1('success')).toEqual({ tone: 'secondary', marked: false, live: false });
    expect(readTriageSignalCellMarkV1('neutral')).toEqual({ tone: 'secondary', marked: false, live: false });
    expect(readTriageSignalCellMarkV1('info')).toEqual({ tone: 'secondary', marked: true, live: false });
    expect(readTriageSignalCellMarkV1('warning')).toEqual({ tone: 'attention', marked: true, live: false });
    expect(readTriageSignalCellMarkV1('danger')).toEqual({ tone: 'danger', marked: true, live: false });
    // A working agent is the one moving mark, in the ink; a finished or idle one is a quiet word.
    expect(readTriageAgentCellMarkV1({ tone: 'neutral', live: true })).toEqual({ tone: 'secondary', marked: true, live: true });
    expect(readTriageAgentCellMarkV1({ tone: 'neutral', live: false })).toEqual({ tone: 'secondary', marked: false, live: false });
    expect(readTriageAgentCellMarkV1({ tone: 'attention', live: false })).toEqual({ tone: 'attention', marked: true, live: false });
    expect(readTriageAgentCellMarkV1({ tone: 'danger', live: false })).toEqual({ tone: 'danger', marked: true, live: false });
  });

  it('marks an entry by its kind, and by where its lifecycle stands', () => {
    // Before the kind vocabulary existed every row wore a pull-request glyph;
    // an issue list and an error-group list were indistinguishable at a glance.
    expect(readTriageRowMarkV1(displayRow({}), 'issue').name).toBe('issue');
    expect(readTriageRowMarkV1(displayRow({}), 'errorIssue').name).toBe('bug');
    expect(readTriageRowMarkV1(displayRow({}), 'pullRequest').name).toBe('change-open');
    expect(readTriageRowMarkV1(displayRow({ lifecyclePresentation: 'resolved' }), 'issue').name).toBe('check');
    expect(readTriageRowMarkV1(displayRow({ lifecyclePresentation: 'resolved' }), 'pullRequest').name)
      .toBe('change-complete');
    expect(readTriageRowMarkV1(displayRow({ lifecyclePresentation: 'closed' }), 'errorIssue').name).toBe('close');
    // A kind nobody declared keeps the lifecycle glyph rather than a guess.
    expect(readTriageRowMarkV1(displayRow({}), null).name).toBe('change-open');
  });

  it('shows and says the provider activity age in the same place', () => {
    const props = triageListRowItemProps(
      displayRow({ activityAtMs: ANNOUNCED.nowMs - 5 * 60_000 }),
      false,
      ANNOUNCED,
    );
    expect(props.subtitle).toBe('pull-request · example/repository · Open · 5 minutes ago');
    expect(props.accessibilityHint).toBe('pull-request, example/repository, Open, 5 minutes ago');
  });

  it('bounds the row even when the projected title is a paragraph', () => {
    // The bound is not a display preference applied to short titles: it is what
    // keeps a pathological row comparable to its neighbours, so it has to hold
    // exactly where it matters.
    const paragraph = 'Replace the duplicated normalizer. '.repeat(40);
    const props = triageListRowItemProps(displayRow({ title: paragraph }), false, ANNOUNCED);

    expect(props.titleNumberOfLines).toBe(2);
    // ...and the whole title still reaches assistive technology as the row's
    // name, so the bound truncates what is DRAWN and never what is announced.
    expect(props.accessibilityLabel).toBe(paragraph);
  });

  it('carries no detail slot at all when the row has no trailing line', () => {
    expect(Object.hasOwn(triageListRowItemProps(displayRow(), false, ANNOUNCED), 'detail'))
      .toBe(false);
  });

  it('tells a reader that a retained row is not a current observation', () => {
    // The window says once, above the list, that it is showing the last known
    // rows. A reader walking rows never reaches that sentence, so each retained
    // row carries the same fact and the age it is known to.
    const props = triageListRowItemProps(
      displayRow({ stale: true, observedAtMs: ANNOUNCED.nowMs - 240_000 }),
      false,
      ANNOUNCED,
    );

    expect(props.accessibilityHint).toBe(
      'pull-request, example/repository, Open, Stale, last seen 4 minutes ago',
    );
  });
});

describe('the window-honesty line', () => {
  const text = (key: string, fallback?: string, values?: Readonly<Record<string, string | number>>) =>
    (fallback ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? ''));
  const entries = planTriageListContinuationV1({ section: 'entries', state: { kind: 'available' }, text });
  const sources = [
    { sourceInstanceId: 'gh', displayLabel: 'GitHub' },
    { sourceInstanceId: 'ado', displayLabel: 'Azure DevOps' },
  ];

  it('says the loaded rows are everything only when the window claims complete coverage', () => {
    expect(readTriageWindowStatementV1({
      loadedCount: 12,
      window: { coverage: 'complete', lanes: [] },
      configuredSources: sources,
      entries,
      text,
    })).toEqual(['12 loaded', 'complete']);
  });

  it('names the connections that may have more, rather than computing a total it does not know', () => {
    expect(readTriageWindowStatementV1({
      loadedCount: 12,
      window: {
        coverage: 'partial',
        lanes: [
          { sourceInstanceId: 'gh', source: SOURCE, health: { kind: 'walkFinished' }, exhausted: true },
          { sourceInstanceId: 'ado', source: SOURCE, health: { kind: 'walkFinished' }, exhausted: false },
        ],
      },
      configuredSources: sources,
      entries,
      text,
    })).toEqual(['12 loaded', 'Azure DevOps may have more']);
  });

  it('says a failed read in the continuation copy\u2019s own words, and nothing before a window exists', () => {
    const failed = planTriageListContinuationV1({ section: 'entries', state: { kind: 'failed' }, text });
    expect(readTriageWindowStatementV1({
      loadedCount: 3, window: { coverage: 'partial', lanes: [] }, configuredSources: sources, entries: failed, text,
    })).toEqual(['3 loaded', failed.title]);
    expect(readTriageWindowStatementV1({
      loadedCount: 0, window: null, configuredSources: sources, entries, text,
    })).toBeUndefined();
  });

  it('says what the pins have left, beside the window, while there are more of them', () => {
    const pins = planTriageListContinuationV1({ section: 'pins', state: { kind: 'available' }, text });
    expect(readTriageWindowStatementV1({
      loadedCount: 0, window: null, configuredSources: sources, entries, pins, text,
    })).toEqual([pins.title]);
  });
});

describe('what a continuation row is told to say', () => {
  const text: TriageTextResolverV1 = (key, fallback) => fallback ?? key;

  it('offers the read when the owner says one is available', () => {
    const copy = planTriageListContinuationV1({
      section: 'entries',
      state: { kind: 'available' },
      text,
    });

    expect(copy.actionLabel).toBe('Load more');
    expect(copy.busy).toBe(false);
    expect(copy.tone).toBe('neutral');
  });

  it('says the rows already listed survived the failure, and offers a retry', () => {
    // The retention is the fact the reader cannot see for themselves. Without
    // it a failed append reads as "the list broke" over rows that are fine.
    const copy = planTriageListContinuationV1({
      section: 'entries',
      state: { kind: 'failed' },
      text,
    });

    expect(copy.title).toBe('More entries could not be loaded');
    expect(copy.description).toContain('still here');
    expect(copy.tone).toBe('warning');
    expect(copy.actionLabel).toBe('Try again');
  });

  it('states the list is incomplete, and offers no press, when nothing can be resumed', () => {
    // Not `exhausted` — the walk did not finish — and not `available` either:
    // no connection left a frontier, so a press would re-read page one and
    // deliver rows the mount already holds. The row says so and points at
    // Refresh, which is the control that can change the answer.
    const copy = planTriageListContinuationV1({
      section: 'entries',
      state: { kind: 'unresumable' },
      text,
    });

    expect(copy.title).toBe('Some entries could not be reached');
    expect(copy.tone).toBe('warning');
    expect(copy.actionLabel).toBeUndefined();
    expect(copy.busy).toBe(false);

    expect(planTriageListContinuationV1({ section: 'pins', state: { kind: 'unresumable' }, text }).title)
      .toBe('Some pins could not be reached');
  });

  it('offers nothing while the owner has published no state to offer', () => {
    // The mounted window publishes no arm before it has assembled one, and an
    // `available` invented here would be a press the store already refuses.
    expect(planTriageListContinuationV1({ section: 'entries', state: undefined, text }).actionLabel)
      .toBeUndefined();
    expect(planTriageListContinuationV1({ section: 'entries', state: { kind: 'exhausted' }, text }).actionLabel)
      .toBeUndefined();
  });

  it('speaks about pins in the pinned section, not about entries', () => {
    // One vocabulary for two sections would tell a reader their PINS were
    // bounded by a source walk they have nothing to do with.
    const copy = planTriageListContinuationV1({ section: 'pins', state: { kind: 'failed' }, text });

    expect(copy.title).toBe('More pins could not be loaded');
    expect(copy.actionLabel).toBe('Try again');
  });
});
