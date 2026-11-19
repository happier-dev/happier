import { expect, it } from 'vitest';
import {
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
    GITHUB_FIXTURE_REPOSITORY_ID,
    GITHUB_SEARCH_PULL_REQUEST_ITEM,
} from '../../../../scm-github/src/triage/__fixtures__/githubResponses.js';
import { decodeGithubSearchItem, projectGithubEntry } from '../../../../scm-github/src/triage/mapping/entry.js';
import { toTriageScanObservation } from '../../../../scm-github/src/triage/mapping/protocol.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import { createNoPersistenceTriageFixture, installDeviceWriteTraps } from '../../projection/noPersistence.test-support.js';
import { projectTriageWindowRow } from '../marks/pinnedRows.js';
import { projectTriageEntryDisplay } from './entryDisplay.js';
import { createTriageEphemeralSharedScopeOriginFixture } from './ephemeralSharedScope.test-support.js';
import {
    acquireTriageListWindow,
    readTriageListWindowReadOwner,
    refreshTriageListWindow,
    type TriageListWindowHostV1,
} from './mountedWindow.js';

it('keeps an oversized first-party mapped entry present through Corpus, its mounted window and display projections without durable writes', async () => {
    const view = decodeGithubSearchItem({
        ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
        title: 'ß'.repeat(20_000),
        labels: Array.from({ length: 300 }, (_unused, index) => ({
            name: index === 0 ? 'oversized-value'.repeat(2_000) : `label-${index}`,
        })),
    });
    if (!view) throw new Error('Identity-valid provider fixture did not decode');
    const mapped = projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID);
    if (!mapped) throw new Error('Identity-valid provider fixture did not map');
    const observation = toTriageScanObservation({
        kind: 'present', ...mapped, viewer: { involvement: ['author'] },
    });
    const result = TriageScanResultV1Schema.parse({
        kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [observation],
    });
    expect(observation.snapshot.projectionTruncated).toBe(true);
    const encode = new TextEncoder();
    const titleBytes = encode.encode(observation.snapshot.title).byteLength;
    expect(titleBytes).toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    expect(titleBytes).toBeGreaterThan(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 - encode.encode('ß').byteLength);
    expect(view.labelNames).toHaveLength(300);
    const labelFact = observation.snapshot.facts?.find(fact => fact.id === 'github/labels')?.value;
    if (labelFact?.kind !== 'text') throw new Error('The oversized labels lost their summary');
    expect(encode.encode(labelFact.value).byteLength).toBe(MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);

    // The existing fixture supplies admitted operation handles and throws at
    // every Account/daemon storage write. Its read/apply/fold path stays real.
    const fixture = createNoPersistenceTriageFixture();
    await fixture.verifyDurableWriteTraps();
    fixture.setScan(async () => result);
    const host: TriageListWindowHostV1 = {
        executeAction: async (_action, input) => await fixture.readEntries(TriageListEntriesInputV1Schema.parse(input)),
    };
    const lifetime = createTriageEphemeralSharedScopeOriginFixture();
    const scope = lifetime.forExecutionOrigin('oversized-provider');
    const lease = acquireTriageListWindow(host, scope);
    const device = installDeviceWriteTraps();
    try {
        await refreshTriageListWindow('view', host, scope);
        const window = readTriageListWindowReadOwner(host, scope)!.getSnapshot().window;
        const row = window?.rows.find(row => row.entryRef.entryId === observation.localRef.entryId);
        expect(row).toBeDefined();
        if (!row) throw new Error('Oversized entry disappeared from the mounted window');
        expect(row.presence.kind).toBe('present');
        expect(row.content?.outcome.snapshot.projectionTruncated).toBe(true);
        expect(row.content?.outcome.snapshot.title).toBe(observation.snapshot.title);
        expect(row.content?.outcome.snapshot.facts?.find(fact => fact.id === 'github/labels')?.value).toEqual(labelFact);
        expect(window?.lanes.filter(lane => lane.source.localId === 'example-forge')
            .map(lane => lane.health)).toEqual([{ kind: 'walkFinished' }, { kind: 'walkFinished' }]);
        const list = projectTriageWindowRow(row, new Map());
        const detail = projectTriageEntryDisplay(row);
        expect(list).toMatchObject({ materialized: true, title: observation.snapshot.title });
        expect(detail).toMatchObject({ title: observation.snapshot.title });
        expect(fixture.durableWriteAttempts).toEqual([]);
        expect(device.attempts).toEqual([]);
    } finally {
        device.restore();
        lease.release();
        lifetime.retire();
    }
});
