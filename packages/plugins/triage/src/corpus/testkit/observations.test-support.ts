import {
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceViewerFactsV1Schema,
    type TriageEntryLocatorV1,
    type TriageEntryRefV1,
    type TriageSourceEntrySnapshotV1,
    type TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';

import type { ProjectedObservationV1 } from '../fold/projectedObservation.js';

/**
 * Fixtures for the observation fold, attention, selection and qualification
 * tests.
 *
 * Every public value is built through the published protocol schemas, so a
 * fixture that would be rejected on the wire cannot silently pass a test.
 */

export const TRIAGE_TESTKIT_SOURCE = Object.freeze({
    pluginId: 'happier.example.source',
    localId: 'example-forge',
});

export const TESTKIT_SOURCE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

export function testkitEntryRef(overrides: Partial<TriageEntryRefV1> = {}): TriageEntryRefV1 {
    return Object.freeze({
        source: TRIAGE_TESTKIT_SOURCE,
        kindId: 'pull-request',
        collisionScope: 'example/repository',
        entryId: '17',
        ...overrides,
    });
}

export function testkitLocator(overrides: Partial<TriageEntryLocatorV1> = {}): TriageEntryLocatorV1 {
    return Object.freeze({
        v: 1,
        webUrl: 'https://example.test/example/repository/pull/17',
        displayPath: 'example/repository #17',
        ...overrides,
    }) as TriageEntryLocatorV1;
}

export function testkitSnapshot(overrides: Partial<TriageSourceEntrySnapshotV1> = {}): TriageSourceEntrySnapshotV1 {
    const candidate: Record<string, unknown> = {
        v: 1,
        title: 'Replace the duplicated normalizer',
        scopeLabel: 'example/repository',
        createdAtMs: 1_760_000_000_000,
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: [],
        ...overrides,
    };
    // An explicitly `undefined` override omits the optional member, exactly as
    // a source that never emitted it would.
    for (const [key, value] of Object.entries(candidate)) {
        if (value === undefined) delete candidate[key];
    }
    return TriageSourceEntrySnapshotV1Schema.parse(candidate);
}

export function testkitViewer(overrides: Partial<TriageSourceViewerFactsV1> = {}): TriageSourceViewerFactsV1 {
    return TriageSourceViewerFactsV1Schema.parse({
        involvement: [],
        ...overrides,
    });
}

type PresentOutcome = Extract<ProjectedObservationV1['outcome'], Readonly<{ kind: 'present' }>>;

export function testkitPresentOutcome(overrides: Partial<PresentOutcome> = {}): PresentOutcome {
    return Object.freeze({
        kind: 'present',
        locator: testkitLocator(),
        snapshot: testkitSnapshot(),
        viewer: testkitViewer(),
        ...overrides,
    }) as PresentOutcome;
}

/** One projected observation of the current pass. Present unless told otherwise. */
export function testkitObservation(
    overrides: Partial<ProjectedObservationV1> = {},
): ProjectedObservationV1 {
    return Object.freeze({
        sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
        observedAtMs: 1_760_000_100_000,
        outcome: testkitPresentOutcome(),
        ...overrides,
    });
}
