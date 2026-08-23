import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import {
  TriageListContinuationRow,
  triageListRowItemProps,
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
    });
  });

  it('carries no detail slot at all when the row has no trailing line', () => {
    expect(Object.hasOwn(triageListRowItemProps(displayRow(), false), 'detail')).toBe(false);
  });
});

describe("a section's continuation row", () => {
  it('announces the statement that the section is not finished', () => {
    // §4.2 chose a stated row over an invisible scroll trigger precisely so the
    // limit is announced. A name pinned to the heading alone said "More entries
    // may exist" and withheld the sentence that says why.
    const element = TriageListContinuationRow({
      title: 'More entries may exist',
      description: 'This window is bounded; sources that had not finished are still walking.',
    }) as React.ReactElement<Record<string, unknown>>;

    expect(element.props.accessibilityLabel).toBe('More entries may exist');
    expect(element.props.accessibilityHint)
      .toBe('This window is bounded; sources that had not finished are still walking.');
    expect(element.props.subtitle)
      .toBe('This window is bounded; sources that had not finished are still walking.');
  });
});
