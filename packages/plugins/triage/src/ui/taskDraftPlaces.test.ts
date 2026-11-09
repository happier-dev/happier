import { describe, expect, it } from 'vitest';
import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation, testkitPresentOutcome, testkitSnapshot, TRIAGE_TESTKIT_SOURCE } from '../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../projection/listWindow.js';
import { defaultTriageTaskDraftPlaceV1, suggestTriageTaskDraftPlacesV1 } from './taskDraftPlaces.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../internalTasks/identity.js';
import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import type { TriageListLaneHealthV1 } from '../projection/listWindow.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' } as const;
const instance = '11111111-1111-4111-8111-111111111111';
const otherInstance = '22222222-2222-4222-8222-222222222222';
const source = TRIAGE_TESTKIT_SOURCE;
const place = { source, sourceInstanceId: instance, kindId: 'issue' };

function windowRows(evidence: readonly Readonly<{ sourceInstanceId?: string; repository?: TriageEntryRepositoryRefV1; scopeUnitId?: string }>[]) {
  const observations = evidence.map((value, index) => ({
    ...testkitObservation({ sourceInstanceId: value.sourceInstanceId ?? instance,
      outcome: testkitPresentOutcome({ ...(value.repository === undefined ? {} : { repository: value.repository }),
        snapshot: testkitSnapshot({ ...(value.scopeUnitId === undefined ? {} : { scopeUnitId: value.scopeUnitId }) }),
      }),
    }),
    entryRef: testkitEntryRef({ entryId: String(index) }),
  }));
  return foldTriageListWindow({ observations, lanes: [], configuredSourcesStatus: 'complete',
    activeSourceInstanceIds: [instance, otherInstance], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1,
  }).rows;
}

describe('Session repository suggestions for the existing Where choices', () => {
  it('defaults to the built-in task only after that source answered without a failure', () => {
    const internal = { ...place, source: INTERNAL_TASK_SOURCE_V1, kindId: 'task' };
    const snapshot = (health: TriageListLaneHealthV1): TriageListWindowSnapshotV1 => ({
      freshness: 'fresh', pending: 'idle', passes: 1, configuredSources: [],
      window: foldTriageListWindow({ observations: [], configuredSourcesStatus: 'complete',
        activeSourceInstanceIds: [instance], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1,
        lanes: [{ source: internal.source, sourceInstanceId: instance, exhausted: true, health }],
      }),
    });
    const places = [place, internal];
    const readable = snapshot({ kind: 'walkFinished' });
    expect(defaultTriageTaskDraftPlaceV1(places, undefined)).toBeUndefined();
    expect(defaultTriageTaskDraftPlaceV1(places, snapshot({ kind: 'unavailable' }))).toBeUndefined();
    expect(defaultTriageTaskDraftPlaceV1(places, snapshot({ kind: 'failed', failure: { class: 'transient', code: 'unreachable' } }))).toBeUndefined();
    expect(defaultTriageTaskDraftPlaceV1(places, { ...readable,
      unreadableSources: [{ sourceInstanceId: instance, message: 'The read did not settle.' }],
    })).toBeUndefined();
    expect(defaultTriageTaskDraftPlaceV1(places, readable)).toBe(internal);
  });

  it('joins canonical repository evidence to admitted create places, preserving multiple connections and native units', () => {
    const rows = windowRows([
      { repository, scopeUnitId: 'opaque-unit-a' }, { repository, scopeUnitId: 'opaque-unit-a' },
      { repository, sourceInstanceId: otherInstance, scopeUnitId: 'opaque-unit-b' },
    ]);
    const suggestions = suggestTriageTaskDraftPlacesV1(repository, rows, [place, { ...place, sourceInstanceId: otherInstance }]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions).toEqual(expect.arrayContaining([
      { ...place, scopeUnitId: 'opaque-unit-a' }, { ...place, sourceInstanceId: otherInstance, scopeUnitId: 'opaque-unit-b' },
    ]));
  });

  it('does not guess a place from a matching label, unavailable repository, foreign source, or changed deployment', () => {
    const rows = windowRows([{ scopeUnitId: 'example/repository' },
      { repository: { ...repository, deployment: 'https://another.example' } },
      { repository, sourceInstanceId: otherInstance }]);
    expect(suggestTriageTaskDraftPlacesV1(repository, rows, [place])).toEqual([]);
    expect(suggestTriageTaskDraftPlacesV1(undefined, windowRows([{ repository }]), [place])).toEqual([]);
    expect(suggestTriageTaskDraftPlacesV1(repository, windowRows([{ repository }]), [{ ...place,
      source: { ...source, pluginId: 'example.foreign' } }])).toEqual([]);
  });
});
