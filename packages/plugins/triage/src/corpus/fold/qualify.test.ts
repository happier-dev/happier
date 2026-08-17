import type { TriageSourceObservationV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    TRIAGE_TESTKIT_SOURCE,
    testkitEntryRef,
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../testkit/observations.test-support.js';
import { qualifySourceObservation } from './qualify.js';

const LOCAL_REF = { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' } as const;
const SOURCE_INSTANCE_ID = '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05';

function qualify(observation: TriageSourceObservationV1, requestedEntryRef?: Parameters<typeof testkitEntryRef>[0]) {
    return qualifySourceObservation({
        source: TRIAGE_TESTKIT_SOURCE,
        declaredKindIds: ['pull-request', 'issue'],
        sourceInstanceId: SOURCE_INSTANCE_ID,
        observedAtMs: 1_760_000_500_000,
        observation,
        ...(requestedEntryRef ? { requestedEntryRef: testkitEntryRef(requestedEntryRef) } : {}),
    });
}

const presentObservation: TriageSourceObservationV1 = {
    kind: 'present',
    localRef: LOCAL_REF,
    locator: testkitLocator(),
    snapshot: testkitSnapshot(),
    viewer: testkitViewer(),
    sourceUpdatedAtMs: 1_759_000_000_000,
};

describe('qualifySourceObservation', () => {
    it('stamps the source, instance and host clock and discards the local ref', () => {
        const result = qualify(presentObservation);

        expect(result.status).toBe('qualified');
        if (result.status !== 'qualified') return;
        expect(result.observation.entryRef).toEqual(testkitEntryRef());
        expect(result.observation.sourceInstanceId).toBe(SOURCE_INSTANCE_ID);
        expect(result.observation.observedAtMs).toBe(1_760_000_500_000);
        expect(JSON.stringify(result.observation)).not.toContain('localRef');
        expect(result.observation.outcome).toEqual({
            kind: 'present',
            locator: testkitLocator(),
            snapshot: testkitSnapshot(),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 1_759_000_000_000,
        });
    });

    it('consumes the collision scope and entry id verbatim', () => {
        const result = qualify({
            ...presentObservation,
            localRef: { kindId: 'pull-request', collisionScope: ' Example/Repository ', entryId: '007' },
        });

        expect(result.status === 'qualified' && result.observation.entryRef).toMatchObject({
            collisionScope: ' Example/Repository ',
            entryId: '007',
        });
    });

    it('rejects a get result whose returned localRef differs from the requested qualified ref', () => {
        // Treating a different result as a redirect would let a source result
        // change the aggregate's canonical identity after qualification.
        expect(qualify(presentObservation, { entryId: '18' })).toEqual({
            status: 'rejected',
            reason: 'refMismatch',
        });
        expect(qualify(presentObservation, {}).status).toBe('qualified');
    });

    it('rejects a kind the invoked source descriptor does not declare', () => {
        expect(qualify({
            ...presentObservation,
            localRef: { ...LOCAL_REF, kindId: 'discussion' },
        })).toEqual({ status: 'rejected', reason: 'undeclaredKind' });
    });

    it('rejects a local ref that does not satisfy the published grammar', () => {
        expect(qualify({
            ...presentObservation,
            localRef: { ...LOCAL_REF, entryId: '' },
        })).toEqual({ status: 'rejected', reason: 'invalidLocalRef' });
    });

    it('keeps an unresolved answer as its own outcome rather than a present or absent one', () => {
        const result = qualify({
            kind: 'unresolved',
            localRef: LOCAL_REF,
            failure: { class: 'rateLimit', code: 'example/throttled' },
        });

        expect(result.status === 'qualified' && result.observation.outcome).toEqual({
            kind: 'unresolved',
            failure: { class: 'rateLimit', code: 'example/throttled' },
        });
    });

    it('qualifies a merged successor into a canonical entry ref of the same source', () => {
        const result = qualify({
            kind: 'merged',
            localRef: LOCAL_REF,
            successor: { kindId: 'issue', collisionScope: 'example/repository', entryId: '99' },
        });

        expect(result.status === 'qualified' && result.observation.outcome).toEqual({
            kind: 'merged',
            successor: testkitEntryRef({ kindId: 'issue', entryId: '99' }),
        });
    });

    /**
     * `CONTRACT.md` §4 fixes the serialized shape of absence at exactly
     * `{ kind, localRef }`: only an authoritative `get` can produce it, so the
     * operation boundary already establishes the basis and a second `basis`
     * member on the projection is a fact the aggregate would be re-minting.
     */
    it('carries no basis of its own for an authoritative absent result', () => {
        const result = qualify({ kind: 'absent', localRef: LOCAL_REF }, {});

        expect(result.status === 'qualified' && result.observation.outcome).toEqual({ kind: 'absent' });
    });
});
