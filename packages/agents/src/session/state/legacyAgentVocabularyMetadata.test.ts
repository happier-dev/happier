import { describe, expect, it } from 'vitest';

import { normalizeLegacyAgentVocabularySessionMetadata } from './legacyAgentVocabularyMetadata.js';

describe('normalizeLegacyAgentVocabularySessionMetadata', () => {
  it('normalizes legacy external history import identity without mutating the input', () => {
    const metadata = {
      externalHistoryImportV1: {
        v: 1,
        providerId: 'claude',
        remoteSessionId: 'session-1',
        importedAtMs: 123,
        source: { kind: 'claude' },
      },
    };

    const normalized = normalizeLegacyAgentVocabularySessionMetadata(metadata);

    expect(normalized).toEqual({
      externalHistoryImportV1: {
        v: 1,
        agentId: 'claude',
        remoteSessionId: 'session-1',
        importedAtMs: 123,
        source: { kind: 'claude' },
      },
    });
    expect(metadata.externalHistoryImportV1).toHaveProperty('providerId', 'claude');
  });
});
