import { afterEach, expect, it, vi } from 'vitest';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { SessionInputEvidence } from './usageQuerySessionInputs';
import { UsageQueryEvidencePhase } from './usageQueryEvidencePhase';

afterEach(() => vi.restoreAllMocks());

it('advances evidence phases with work proportional to changed Sessions, including refusal and completion', () => {
    const ids = Array.from({ length: 3423 }, (_, index) => `session-${index}`);
    let visits = 0;
    const values: SessionInputEvidence[] = ids.map(id => {
        const session = projectUsageSessionInput(createSessionFixture({ id, encryptionMode: 'plain' }));
        return { get session() { visits++; return session; }, callerDataKeyEnvelope: null,
            detail: projectSessionUsageWorkEvidence(session), completeMessageCoverage: false };
    });
    const phase = new UsageQueryEvidencePhase(ids.length, true);
    const stringify = vi.spyOn(JSON, 'stringify');
    const publications = [phase.read()];
    values.forEach((value, index) => {
        phase.select(ids[index]!, value);
        const snapshot = phase.read();
        if (snapshot) publications.push(snapshot);
    });
    expect(phase.selected.size).toBe(ids.length);
    expect(publications).toMatchObject([
        { admitted: false, refused: false, sources: [{ status: 'pending' }, { status: 'pending' }] },
        { admitted: true, refused: false, sources: [{ status: 'available' }, { status: 'pending' }] },
    ]);
    expect(stringify.mock.calls.length, 'source-phase serialization must follow changed publications, not the selected Session population')
        .toBeLessThanOrEqual(publications.length);
    stringify.mockRestore();
    console.info(JSON.stringify({ sessions: ids.length, phaseInputVisits: visits, publications: publications.length }));
    expect(visits, 'one Session arrival must not rescan the already admitted population').toBe(ids.length);
    const admittedVisits = visits;
    for (let refresh = 0; refresh < 44; refresh++) {
        phase.select(ids[0]!, values[0]!);
        expect(phase.read()).toBeUndefined();
    }
    expect(visits, 'unchanged arrivals must not revisit Session evidence').toBe(admittedVisits);

    // A refusal withdraws availability before unfinished siblings complete.
    phase.select(ids[0]!, null);
    expect(phase.read()).toMatchObject({ admitted: true, refused: true,
        sources: [{ status: 'partial' }, { status: 'pending' }] });
    phase.select(ids[0]!, values[0]!);
    expect(phase.read()).toMatchObject({ refused: false, sources: [{ status: 'available' }, { status: 'pending' }] });
    values.forEach((value, index) => {
        phase.select(ids[index]!, { ...value, completeMessageCoverage: true }, true);
        if (index < ids.length - 1) expect(phase.read()).toBeUndefined();
    });
    expect(phase.read()).toMatchObject({ admitted: true, refused: false,
        sources: [{ status: 'available' }, { status: 'available' }] });
    expect(phase.complete).toBe(true);
    const restricted = projectUsageSessionInput(createSessionFixture({ id: ids[0]!,
        access: createSessionAccessFixture('view', { readTranscript: false }) }));
    phase.select(ids[0]!, { session: restricted, callerDataKeyEnvelope: null,
        detail: projectSessionUsageWorkEvidence(restricted), completeMessageCoverage: true }, true);
    expect(phase.read()).toMatchObject({ refused: false, sources: [{ status: 'partial' }, { status: 'partial' }] });
    phase.select(ids[0]!, { ...values[0]!, completeMessageCoverage: true }, true);
    expect(phase.read()).toMatchObject({ sources: [{ status: 'available' }, { status: 'available' }] });
});

it('settles summary-only and empty evidence reads without inventing transcript demand', () => {
    const empty = new UsageQueryEvidencePhase(0, false);
    expect(empty.read()).toMatchObject({ admitted: true, refused: false,
        sources: [{ status: 'available' }, { status: 'not_loaded' }] });
    expect(empty.read()).toBeUndefined();
    const denied = new UsageQueryEvidencePhase(1, false);
    denied.select('denied', null, true);
    expect(denied.read()).toMatchObject({ admitted: true, refused: true,
        sources: [{ status: 'partial' }, { status: 'not_loaded' }] });
});
