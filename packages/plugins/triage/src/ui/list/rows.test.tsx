import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import {
  planTriageListContinuationV1,
  type TriageListContinuationCopyV1,
} from './continuation.js';
import {
  TRIAGE_ROW_SELECT_ACTION_ID_V1,
  TriageListContinuationRow,
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
    pinned: false,
    materialized: true,
    sourceInstanceId: null,
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

describe('a PRs & Issues entry row', () => {
  it('keeps the entry as its accessible name and says the rest beside it', () => {
    // `core/SURFACE.md` §7.1 requires the attention reason to be announced.
    // Pinning the name to the title is what stops the shared row composing
    // "Replace the duplicated normalizerexample/repository" — and it is also
    // what silenced every other word on the row until this description existed.
    const props = triageListRowItemProps(displayRow({ detail: 'Your review is requested' }), false);

    expect(props.accessibilityLabel).toBe('Replace the duplicated normalizer');
    expect(props.accessibilityHint).toBe('example/repository, Your review is requested');
  });

  it('still names the owning scope when the row has nothing else to add', () => {
    // Two repositories routinely hold an entry with the same title, and the
    // name deliberately does not disambiguate them.
    expect(triageListRowItemProps(displayRow(), false).accessibilityHint)
      .toBe('example/repository');
  });

  it('announces the freshness note of a pin this mount never materialized', () => {
    const props = triageListRowItemProps(
      displayRow({ detail: 'Not yet synchronized', materialized: false, pinned: true }),
      false,
    );

    expect(props.accessibilityHint).toBe('example/repository, Not yet synchronized');
  });

  it('announces why an entry the source dropped is still listed', () => {
    // A presence note is the row's whole reason for looking different, and it
    // is stated in words rather than by tone alone (§7.1).
    const props = triageListRowItemProps(
      displayRow({ detail: 'No longer reported by the source', tone: 'danger' }),
      false,
    );

    expect(props.accessibilityHint).toBe('example/repository, No longer reported by the source');
    expect(props.tone).toBe('danger');
  });

  it('never repeats the entry it has already been named after', () => {
    // A description that restates the name makes every row announce itself
    // twice, which is the failure the pinned name exists to prevent.
    const props = triageListRowItemProps(displayRow({ detail: 'Your review is requested' }), false);

    expect(props.accessibilityHint).not.toContain('Replace the duplicated normalizer');
  });

  it('shows the same words it announces, in the same order', () => {
    // The description is the row's own visible content, not a second copy that
    // can drift from it. Nothing is announced that the row does not display.
    const props = triageListRowItemProps(displayRow({ detail: 'Your review is requested' }), true);

    expect(props).toEqual({
      testID: triageListRowTestId('happier.forge/items|pull-request|origin|31'),
      title: 'Replace the duplicated normalizer',
      subtitle: 'example/repository',
      detail: 'Your review is requested',
      tone: 'neutral',
      busy: true,
      accessibilityLabel: 'Replace the duplicated normalizer',
      accessibilityHint: 'example/repository, Your review is requested',
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

  it('bounds the row even when the projected title is a paragraph', () => {
    // The bound is not a display preference applied to short titles: it is what
    // keeps a pathological row comparable to its neighbours, so it has to hold
    // exactly where it matters.
    const paragraph = 'Replace the duplicated normalizer. '.repeat(40);
    const props = triageListRowItemProps(displayRow({ title: paragraph }), false);

    expect(props.titleNumberOfLines).toBe(2);
    // ...and the whole title still reaches assistive technology as the row's
    // name, so the bound truncates what is DRAWN and never what is announced.
    expect(props.accessibilityLabel).toBe(paragraph);
  });

  it('carries no detail slot at all when the row has no trailing line', () => {
    expect(Object.hasOwn(triageListRowItemProps(displayRow(), false), 'detail')).toBe(false);
  });
});

describe("a section's continuation row", () => {
  function continuationRow(
    copy: Partial<TriageListContinuationCopyV1> = {},
    onLoadMore: () => void = () => undefined,
  ): React.ReactElement<Record<string, unknown>> {
    return TriageListContinuationRow({
      copy: {
        title: 'More entries may exist',
        description: 'This window is bounded; load more to reach the entries after these.',
        tone: 'neutral',
        busy: false,
        ...copy,
      },
      onLoadMore,
    }) as React.ReactElement<Record<string, unknown>>;
  }

  it('announces the statement that the section is not finished', () => {
    // §4.2 chose a stated row over an invisible scroll trigger precisely so the
    // limit is announced. A name pinned to the heading alone said "More entries
    // may exist" and withheld the sentence that says why.
    const element = continuationRow();

    expect(element.props.accessibilityLabel).toBe('More entries may exist');
    expect(element.props.accessibilityHint)
      .toBe('This window is bounded; load more to reach the entries after these.');
    expect(element.props.subtitle)
      .toBe('This window is bounded; load more to reach the entries after these.');
  });

  it('carries the section continuation control, and it is what invokes the read', () => {
    // The row was written inert because there was nothing for it to invoke.
    // There is now, and the press has to reach it — a labelled control that
    // does nothing is the exact failure the inert row was chosen to avoid.
    let demands = 0;
    const element = continuationRow(
      { actionLabel: 'Load more' },
      () => { demands += 1; },
    );
    const accessory = element.props.accessory as React.ReactElement<Record<string, unknown>>;

    expect(accessory.props.title).toBe('Load more');
    expect(accessory.props.busy).toBe(false);
    (accessory.props.onPress as () => void)();
    expect(demands).toBe(1);
  });

  it('renders no control at all when pressing would read nothing', () => {
    // Not a DISABLED control: the row's own copy already says why there is
    // nothing to press, and offering a dead affordance beside it is what
    // `core/CORPUS.md` §4.2 refuses.
    expect(Object.hasOwn(continuationRow().props, 'accessory')).toBe(false);
  });

  it('keeps the control mounted and busy while the read it asked for runs', () => {
    // Unmounting it would move focus off the thing the reader just pressed.
    const accessory = continuationRow({ actionLabel: 'Load more', busy: true })
      .props.accessory as React.ReactElement<Record<string, unknown>>;

    expect(accessory.props.busy).toBe(true);
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

  it('names OUR bound at the ceiling rather than implying the sources finished', () => {
    const copy = planTriageListContinuationV1({
      section: 'entries',
      state: { kind: 'atCeiling' },
      text,
    });

    expect(copy.title).toBe('This page holds as many entries as it can');
    expect(copy.actionLabel).toBeUndefined();
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
