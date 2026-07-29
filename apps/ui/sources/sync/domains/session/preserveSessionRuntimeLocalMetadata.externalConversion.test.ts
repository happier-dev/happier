import { describe, expect, it } from 'vitest';

import { preserveSessionRuntimeLocalMetadata } from './preserveSessionRuntimeLocalMetadata';

describe('preserveSessionRuntimeLocalMetadata external conversion', () => {
    it('does not restore external-session identity over a persisted conversion marker', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            {
                path: '/repo',
                externalSessionV1: { v: 1, agentId: 'codex', source: 'codexHome' },
            },
            {
                path: '/repo',
                externalHistoryImportV1: { v: 1, importedAt: 1_000 },
            },
        );

        expect(result).toMatchObject({
            externalHistoryImportV1: { v: 1, importedAt: 1_000 },
        });
        expect(result).not.toHaveProperty('externalSessionV1');
    });
});
