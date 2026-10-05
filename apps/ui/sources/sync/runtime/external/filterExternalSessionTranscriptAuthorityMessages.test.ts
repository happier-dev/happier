import { describe, expect, it } from 'vitest';

import { filterExternalSessionTranscriptAuthorityMessages } from './filterExternalSessionTranscriptAuthorityMessages';
import { buildVoiceTranscriptNoteMeta } from '@/voice/transcript/voiceTranscriptNoteMeta';

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
    it('retains acknowledged host continuation notes without admitting competing persisted Agent transcript rows', () => {
        const note = { id: 'host-note', localId: 'voice-note:1', seq: 5, meta: buildVoiceTranscriptNoteMeta({ continuation:
            { v: 1, deviceId: 'device', conversation: { serverId: 'home', sessionId: 'session' } } }) };
        expect(filterExternalSessionTranscriptAuthorityMessages([note, message()], { kind: 'live_agent', sourceKey: 'source' })).toEqual([note]);
        expect(filterExternalSessionTranscriptAuthorityMessages([note, message({ seq: 5 })], { kind: 'server_snapshot', maxServerSeq: 4, materializedThroughSourceAt: 1 })).toEqual([note]);
        expect(filterExternalSessionTranscriptAuthorityMessages([{ ...note, seq: undefined }], { kind: 'live_agent', sourceKey: 'source' })).toEqual([]);
        expect(filterExternalSessionTranscriptAuthorityMessages([note], { kind: 'unavailable', reason: 'legacy_external_unknown' })).toEqual([]);
    });
    it('applies the same publication authority to content-free metadata refreshes', () => {
        const metadata = { id: 'server-row-1', localId: liveId, seq: 4, accountActor: null };
        expect(filterExternalSessionTranscriptAuthorityMessages([metadata], { kind: 'live_agent', sourceKey: 'source-1' })).toEqual([]);
        expect(filterExternalSessionTranscriptAuthorityMessages([metadata], { kind: 'server_snapshot', maxServerSeq: 3, materializedThroughSourceAt: 1 })).toEqual([]);
        expect(filterExternalSessionTranscriptAuthorityMessages([metadata], { kind: 'server_snapshot', maxServerSeq: 4, materializedThroughSourceAt: 1 }))
            .toEqual([{ ...metadata, id: liveId }]);
    });
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
