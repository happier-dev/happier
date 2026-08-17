import { describe, expect, it } from 'vitest';

import { preserveSessionRuntimeLocalMetadata } from './preserveSessionRuntimeLocalMetadata';

describe('preserveSessionRuntimeLocalMetadata external conversion', () => {
    it('preserves machine identity from released linked-session metadata', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            {
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-released',
                    remoteSessionId: 'thread-released',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
            {},
        );

        expect(result).toMatchObject({ machineId: 'machine-released' });
    });

    it('does not preserve machine identity from malformed linked-session metadata', () => {
        const result = preserveSessionRuntimeLocalMetadata(
            {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-unverified',
                },
            },
            {},
        );

        expect(result).not.toHaveProperty('machineId');
    });

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
