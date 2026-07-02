import { describe, expect, it } from 'vitest';

import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';

describe('isLegacyMemoryArtifactTranscriptRow', () => {
    it('skips legacy memory summary rows by local id', () => {
        expect(isLegacyMemoryArtifactTranscriptRow({
            localId: 'memory:summary_shard:v1:1-10',
            content: { role: 'agent', content: { type: 'text', text: '[memory]' } },
        })).toBe(true);
    });

    it('skips legacy memory synopsis rows by happier meta kind', () => {
        expect(isLegacyMemoryArtifactTranscriptRow({
            localId: null,
            content: {
                role: 'agent',
                content: { type: 'text', text: '[memory]' },
                meta: {
                    happier: {
                        kind: 'session_synopsis.v1',
                        payload: { v: 1, seqTo: 10, updatedAtMs: 100, synopsis: 'summary' },
                    },
                },
            },
        })).toBe(true);
    });

    it('does not skip arbitrary invalid transcript messages', () => {
        expect(isLegacyMemoryArtifactTranscriptRow({
            localId: 'agent-invalid-1',
            content: {
                role: 'agent',
                content: { type: 'text', text: 'invalid but not memory' },
            },
        })).toBe(false);
    });
});
