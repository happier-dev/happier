import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createLocalServiceInventoryAnnotationsFileStore } from './annotationsFile';

describe('inventory annotation failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps absent annotations quiet and records unreadable or corrupt causes without file contents', () => {
        const root = mkdtempSync(join(tmpdir(), 'inventory-annotation-causes-'));
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
            expect(createLocalServiceInventoryAnnotationsFileStore({ path: join(root, 'missing') }).read()).toBeNull();
            expect(diagnostic).not.toHaveBeenCalled();
            const blocker = join(root, 'blocker');
            writeFileSync(blocker, 'private annotation content');
            expect(createLocalServiceInventoryAnnotationsFileStore({ path: join(blocker, 'annotations') }).read()).toBeNull();
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'local_service.annotations.read', errorClass: 'Error', errorCode: null,
            }));
            diagnostic.mockClear();
            writeFileSync(blocker, '{"private annotation content":');
            expect(createLocalServiceInventoryAnnotationsFileStore({ path: blocker }).read()).toBeNull();
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'local_service.annotations.parse', errorClass: 'SyntaxError', errorCode: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private annotation content');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
