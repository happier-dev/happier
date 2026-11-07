import { describe, expect, it } from 'vitest';
import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation, testkitPresentOutcome, testkitSnapshot, TRIAGE_TESTKIT_SOURCE } from '../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../projection/listWindow.js';
import { suggestTriageTaskDraftPlacesV1 } from './taskDraftPlaces.js';

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
