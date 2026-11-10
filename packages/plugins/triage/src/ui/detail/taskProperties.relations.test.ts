import { describe, expect, it } from 'vitest';

import {
  testkitEntryRef,
  testkitObservation,
} from '../../corpus/testkit/observations.test-support.js';
import {
  foldTriageListWindow,
  TRIAGE_LIST_DEFAULT_LENS_V1,
} from '../../projection/listWindow.js';
import {
  projectTriageTaskBlockersV1,
  projectTriageTaskPropertiesV1,
  triageTaskRelationCandidatesV1,
} from './taskProperties.js';

const text = ((_key: string, fallback: string) => fallback) as Parameters<
  typeof projectTriageTaskPropertiesV1
>[0]['text'];

function row(
  entryId: string,
  title: string,
  options: Readonly<{ updatedAtMs: number; done?: boolean }>,
) {
  const base = testkitObservation();
  if (base.outcome.kind !== 'present')
    throw new Error('Expected a present fixture');
  const entryRef = testkitEntryRef({ entryId });
  return foldTriageListWindow({
    observations: [
      {
        ...base,
        entryRef,
        outcome: {
          ...base.outcome,
          localRef: {
            kindId: entryRef.kindId,
            collisionScope: entryRef.collisionScope,
            entryId,
          },
          sourceUpdatedAtMs: options.updatedAtMs,
          snapshot: {
            ...base.outcome.snapshot,
            title,
            designation: `#${entryId}`,
            state:
              options.done === true
                ? { presentation: 'resolved' as const, nativeLabel: 'Done' }
                : { presentation: 'active' as const, nativeLabel: 'Open' },
          },
        },
      },
    ],
    lanes: [],
    configuredSourcesStatus: 'complete',
    activeSourceInstanceIds: [base.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1,
    assembledAtMs: 1_000,
  }).rows[0]!;
}

// The window's own order (by status lane) is not what a person picks a relation by.
const rows = [
  row(
    '832',
    'Light/SQLite relay: session-list responses hold the only DB connection',
    { updatedAtMs: 3_000 },
  ),
  row('877', 'Desktop 0.2.21: React #185 in session transcript', {
    updatedAtMs: 1_000,
    done: true,
  }),
  row('887', 'CLI (macOS): second happier opencode on the same machine fails', {
    updatedAtMs: 5_000,
  }),
];

describe('task relation pickers (Parent, Blocked by)', () => {
  it('offer one searchable picker: the title, the designation as trailing meta, open and recent entries first', () => {
    const candidates = triageTaskRelationCandidatesV1(rows);
    const parent = projectTriageTaskPropertiesV1({
      fields: ['parent'],
      values: { parent: null },
      candidates,
      commit: () => undefined,
      text,
    }).find((item) => item.id === 'parent')!.editor!;
    const blockers = projectTriageTaskBlockersV1({
      blockedBy: [],
      candidates,
      text,
      commit: () => undefined,
    });
    expect(parent).toMatchObject({ kind: 'choice', searchable: true });
    expect(blockers.property.editor).toMatchObject({
      kind: 'choices',
      searchable: true,
    });
    const expected = [
      {
        id: expect.any(String),
        label: 'CLI (macOS): second happier opencode on the same machine fails',
        meta: '#887',
      },
      {
        id: expect.any(String),
        label:
          'Light/SQLite relay: session-list responses hold the only DB connection',
        meta: '#832',
      },
      {
        id: expect.any(String),
        label: 'Desktop 0.2.21: React #185 in session transcript',
        meta: '#877',
      },
    ];
    expect(parent.kind === 'choice' && parent.choices).toEqual(expected);
    const blockerEditor = blockers.property.editor!;
    expect(blockerEditor.kind === 'choices' && blockerEditor.choices).toEqual(
      expected,
    );
    // "Add a blocker" in the story chapter offers the same rows.
    expect(blockers.choices).toEqual(expected);
  });
});
