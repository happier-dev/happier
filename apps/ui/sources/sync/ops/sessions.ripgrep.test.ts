import { describe, expect, it } from 'vitest';

describe('sessions ripgrep contract', () => {
    it('does not expose the removed legacy sessionRipgrep helper', async () => {
        const sessionsModule = await import('./sessions');
        expect((sessionsModule as Record<string, unknown>).sessionRipgrep).toBeUndefined();
    });
});
