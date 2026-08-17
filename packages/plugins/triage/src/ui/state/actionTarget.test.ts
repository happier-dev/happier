import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { resolveTriageActionTargetV1 } from './actionTarget.js';
import {
  TRIAGE_SURFACE_INITIAL_STATE_V1,
  reduceTriageSurfaceV1,
  type TriageSurfaceStateV1,
} from './surface.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' } as const;
const INSTANCE = '1f0d4ab7-6c4a-4f9d-9b2e-0f1a2b3c4d5e' as TriageSourceInstanceIdV1;

function entry(entryId: string): TriageEntryRefV1 {
  return { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId };
}

function selectedThenFocusedElsewhere(): TriageSurfaceStateV1 {
  const selected = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
    kind: 'rowActivated',
    sectionId: '2-open',
    entryRef: entry('12'),
    sourceInstanceId: INSTANCE,
  });
  return reduceTriageSurfaceV1(selected, {
    kind: 'rowFocused',
    sectionId: '3-done',
    entryRef: entry('21'),
  });
}

describe('Triage aggregate action target', () => {
  it('targets the SELECTED entry even while the keyboard cursor sits on another row', () => {
    const target = resolveTriageActionTargetV1(selectedThenFocusedElsewhere());

    // Reading `focus` here is the wrong-row mutation bug: the visible detail and
    // the header Action must always name the same entry.
    expect(target).toEqual({
      kind: 'entry',
      sectionId: '2-open',
      entryRef: entry('12'),
      sourceInstanceId: INSTANCE,
    });
  });

  it('refuses with an accessible reason instead of silently falling back to the focused row', () => {
    const focusedOnly = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'rowFocused',
      sectionId: '2-open',
      entryRef: entry('12'),
    });

    expect(resolveTriageActionTargetV1(focusedOnly)).toEqual({
      kind: 'refused',
      reason: 'noSelectedEntry',
    });
  });

  it('refuses on a surface with neither cursor rather than targeting the first row', () => {
    expect(resolveTriageActionTargetV1(TRIAGE_SURFACE_INITIAL_STATE_V1)).toEqual({
      kind: 'refused',
      reason: 'noSelectedEntry',
    });
  });

  it('keeps targeting a retained selection whose entry has left the visible corpus', () => {
    const selected = selectedThenFocusedElsewhere();
    const afterDisappearance = reduceTriageSurfaceV1(selected, {
      kind: 'visibleRowsChanged',
      previousOrder: [{ sectionId: '2-open', entryRef: entry('12') }],
      visibleOrder: [],
    });

    expect(resolveTriageActionTargetV1(afterDisappearance)).toEqual({
      kind: 'entry',
      sectionId: '2-open',
      entryRef: entry('12'),
      sourceInstanceId: INSTANCE,
    });
  });
});
