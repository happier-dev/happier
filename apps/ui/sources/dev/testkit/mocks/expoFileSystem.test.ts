import { describe, expect, it } from 'vitest';

import { createNativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';

describe('Expo filesystem native boundary', () => {
    it('isolates concurrent revision cache files and preserves their bytes through close', async () => {
        const sinks = await Promise.all([1, 2].map(() => createNativeCacheFileSink({
            directoryName: 'review-pdf', fileName: 'spec.pdf',
        })));
        try {
            expect(sinks).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
            const [before, after] = sinks;
            if (!before?.ok || !after?.ok) throw new Error('Both revision sinks must be available');
            expect(before.fileUri).not.toBe(after.fileUri);
            const beforeBytes = new Uint8Array([0, 255, 13, 10]);
            const afterBytes = new Uint8Array([1, 128, 0]);
            await Promise.all([before.writeBytes(beforeBytes), after.writeBytes(afterBytes)]);
            await Promise.all([before.close(), after.close()]);
            const { File } = await import('expo-file-system');
            expect(await new File(before.fileUri).bytes()).toEqual(beforeBytes);
            expect(await new File(after.fileUri).bytes()).toEqual(afterBytes);
        } finally {
            await Promise.all(sinks.map(sink => sink.ok ? sink.cleanup() : undefined));
        }
    });
});
