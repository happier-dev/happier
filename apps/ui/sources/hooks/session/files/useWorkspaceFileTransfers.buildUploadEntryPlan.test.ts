import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({
    sessionStatFile: vi.fn(async () => ({ success: true, exists: false })),
}));

describe('buildUploadEntryPlan', () => {
    it('detects duplicate target paths within a single upload batch', async () => {
        const { buildUploadEntryPlan } = await import('./useWorkspaceFileTransfers');

        const result = await buildUploadEntryPlan({
            sessionId: 's1',
            destinationDir: '',
            entries: [
                {
                    kind: 'native',
                    uri: 'file:///tmp/a.txt',
                    name: 'a.txt',
                    sizeBytes: 10,
                    mimeType: 'text/plain',
                    relativePath: 'a.txt',
                },
                {
                    kind: 'native',
                    uri: 'file:///tmp/other/a.txt',
                    name: 'a.txt',
                    sizeBytes: 20,
                    mimeType: 'text/plain',
                    relativePath: 'a.txt',
                },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const paths = result.tasks.map((t) => t.targetPath);
        expect(new Set(paths).size).toBe(paths.length);
    });
});
