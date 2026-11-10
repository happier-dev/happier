import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

describe('transcriptSearchUnavailableHint', () => {
    it.each([
        ['home_indexing', 'sessionsList.transcriptSearchHomeIndexing'],
        ['daemon_no_target', 'errors.daemonUnavailableBody'],
        ['daemon_unavailable', 'errors.daemonUnavailableBody'],
        ['home_unavailable', 'sessionsList.transcriptSearchHomeUnavailable'],
        ['home_unknown', 'sessionsList.transcriptSearchHomeUnknown'],
        ['memory_disabled', 'memorySearchSettings.disabled.footer'],
    ])('maps %s to stable contextual status copy', async (reason, expectedKey) => {
        const { transcriptSearchUnavailableHint } = await import('./transcriptSearchUnavailableHint');
        expect(transcriptSearchUnavailableHint(reason)).toBe(expectedKey);
    });
});
