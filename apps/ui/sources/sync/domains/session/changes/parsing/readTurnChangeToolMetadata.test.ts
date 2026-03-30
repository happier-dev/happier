import { describe, expect, it } from 'vitest';

import { readTurnChangeToolMetadata, readTurnChangeToolMetadataFromToolCall } from './readTurnChangeToolMetadata';

describe('readTurnChangeToolMetadata', () => {
    it('parses turn-change metadata from a JSON-stringified tool envelope', () => {
        const payload = {
            files: [{ file_path: 'src/app.ts', oldText: 'a\n', newText: 'b\n' }],
            _happier: {
                sessionChangeScope: 'turn',
                turnId: 'turn_1',
                sessionId: 'session_1',
                provider: 'codex',
                source: 'provider_native',
                confidence: 'exact',
                turnStatus: 'completed',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 10 },
            },
        };

        expect(readTurnChangeToolMetadata(JSON.stringify(payload))).toEqual({
            turnId: 'turn_1',
            sessionId: 'session_1',
            provider: 'codex',
            source: 'provider_native',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 10 },
        });
    });

    it('parses turn-change metadata from a JSON-stringified tool input via readTurnChangeToolMetadataFromToolCall', () => {
        const payload = {
            _happier: {
                sessionChangeScope: 'turn',
                turnId: 'turn_2',
                sessionId: 'session_2',
                provider: 'opencode',
                source: 'provider_tool',
                confidence: 'strong',
                seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
            },
        };

        expect(readTurnChangeToolMetadataFromToolCall({ input: JSON.stringify(payload) })).toEqual({
            turnId: 'turn_2',
            sessionId: 'session_2',
            provider: 'opencode',
            source: 'provider_tool',
            confidence: 'strong',
            turnStatus: 'completed',
            seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
        });
    });

    it('parses turn-change metadata when it is nested under an output envelope', () => {
        const payload = {
            output: {
                _happier: {
                    sessionChangeScope: 'turn',
                    turnId: 'turn_3',
                    sessionId: 'session_3',
                    provider: 'codex',
                    source: 'canonical_diff_tool',
                    confidence: 'exact',
                    turnStatus: 'completed',
                    seqRange: { startSeqInclusive: 9, endSeqInclusive: 12 },
                },
            },
        };

        expect(readTurnChangeToolMetadata(payload)).toEqual({
            turnId: 'turn_3',
            sessionId: 'session_3',
            provider: 'codex',
            source: 'canonical_diff_tool',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: { startSeqInclusive: 9, endSeqInclusive: 12 },
        });
    });

    it('parses turn-change metadata from a JSON-stringified tool_use_result field', () => {
        const embedded = {
            _happier: {
                sessionChangeScope: 'turn',
                turnId: 'turn_4',
                sessionId: 'session_4',
                provider: 'codex',
                source: 'canonical_patch_tool',
                confidence: 'best_effort',
                turnStatus: 'completed',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 1 },
            },
        };

        expect(readTurnChangeToolMetadata({ tool_use_result: JSON.stringify(embedded) })).toEqual({
            turnId: 'turn_4',
            sessionId: 'session_4',
            provider: 'codex',
            source: 'canonical_patch_tool',
            confidence: 'best_effort',
            turnStatus: 'completed',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 1 },
        });
    });
});
