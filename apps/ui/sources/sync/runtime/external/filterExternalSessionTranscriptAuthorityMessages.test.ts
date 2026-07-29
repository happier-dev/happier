import { describe, expect, it } from 'vitest';

import { filterExternalSessionTranscriptAuthorityMessages } from './filterExternalSessionTranscriptAuthorityMessages';

const liveId = 'direct-import:v1:codex:aaaaaaaaaaaaaaaaaaaaaaaa';

function message(overrides: Record<string, unknown> = {}) {
    return {
        id: 'server-row-1',
        localId: liveId,
        seq: 4,
        kind: 'user-text',
        text: 'hello',
        createdAt: 1,
        ...overrides,
    } as any;
}

describe('filterExternalSessionTranscriptAuthorityMessages', () => {
    it('never peer-applies persisted server ids while live Agent authority is selected', () => {
        expect(filterExternalSessionTranscriptAuthorityMessages(
            [message(), message({ id: liveId, seq: undefined })],
            { kind: 'live_agent', sourceKey: 'source-1' },
        )).toEqual([expect.objectContaining({ id: liveId })]);
    });

    it('canonicalizes imported ids and hides rows beyond the selected publication bound', () => {
        expect(filterExternalSessionTranscriptAuthorityMessages(
            [message(), message({ id: 'staged', seq: 5 })],
            { kind: 'server_snapshot', maxServerSeq: 4, materializedThroughSourceAt: 1 },
        )).toEqual([expect.objectContaining({ id: liveId, seq: 4 })]);
    });

    it('drops every output for unavailable authority and leaves hosted rows unchanged', () => {
        const serverRow = message({ localId: null });
        expect(filterExternalSessionTranscriptAuthorityMessages(
            [serverRow],
            { kind: 'unavailable', reason: 'legacy_external_unknown' },
        )).toEqual([]);
        expect(filterExternalSessionTranscriptAuthorityMessages(
            [serverRow],
            { kind: 'hosted' },
        )).toEqual([serverRow]);
    });
});
