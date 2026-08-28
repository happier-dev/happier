import { describe, expect, it, vi } from 'vitest';

const { randomUUID } = vi.hoisted(() => ({
    randomUUID: vi.fn()
        .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
        .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
        .mockReturnValueOnce('33333333-3333-4333-8333-333333333333'),
}));

vi.mock('@/platform/randomUUID', () => ({ randomUUID }));

import { createTerminalQaRunIdentity, readTerminalQaBuildIdentity } from './evidenceIdentity';

describe('terminal QA evidence identity', () => {
    const buildIdentity = {
        buildEvidenceId: 'term-build-1234567890abcdef',
        sourceStateSha256: 'a'.repeat(64),
        dependencyClosureSha256: 'b'.repeat(64),
    };

    it('reads only a complete validated identity embedded in the app bundle', () => {
        expect(readTerminalQaBuildIdentity({ extra: { app: { terminalNativeEvidenceBuildIdentity: buildIdentity } } }))
            .toEqual(buildIdentity);
        expect(readTerminalQaBuildIdentity({ extra: { app: { terminalNativeEvidenceBuildIdentity: {
            ...buildIdentity,
            sourceStateSha256: 'edited',
        } } } })).toBeNull();
    });

    it('creates a fresh unpredictable run identity without changing the build binding', () => {
        expect(createTerminalQaRunIdentity(buildIdentity)).toEqual({
            ...buildIdentity,
            runId: 'term-run-33333333-3333-4333-8333-333333333333',
            runNonce: '1111111111114111811111111111111122222222222242228222222222222222',
        });
    });
});
