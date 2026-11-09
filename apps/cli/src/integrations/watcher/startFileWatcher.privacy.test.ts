import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import { describe, expect, it, vi } from 'vitest';

import { startFileWatcher } from './startFileWatcher';

describe('startFileWatcher path privacy', () => {
    it('does not log the watched file or its parent directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'file-watcher-path-privacy-'));
        const file = join(root, 'private-session.jsonl');
        await writeFile(file, '{}\n', 'utf8');
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const onChange = vi.fn();
        const attached = createDeferred();
        const dispose = startFileWatcher(file, onChange, {
            emitInitial: false,
            onWatcherAttached: () => attached.resolve(),
        });

        try {
            await attached.promise;
            await appendFile(file, '{}\n', 'utf8');
            await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

            expect(debug.mock.calls.length).toBeGreaterThan(0);
            const messages = inspect(debug.mock.calls, { depth: null });
            expect(messages).not.toContain(file);
            expect(messages).not.toContain(root);
        } finally {
            try {
                await dispose.dispose();
            } finally {
                debug.mockRestore();
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    it('redacts watched paths from watcher failure logging', async () => {
        const root = await mkdtemp(join(tmpdir(), 'file-watcher-error-privacy-'));
        const file = join(root, 'private-session.jsonl');
        await writeFile(file, '{}\n', 'utf8');
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        let attempts = 0;
        const attached = createDeferred();
        const dispose = startFileWatcher(file, async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error(`failed to read ${file}`);
            }
        }, { emitInitial: false, onWatcherAttached: () => attached.resolve() });

        try {
            await attached.promise;
            await appendFile(file, '{}\n', 'utf8');
            await vi.waitFor(() => {
                expect(debug.mock.calls.some(([message]) =>
                    String(message).includes('Watch error'))).toBe(true);
            });

            const messages = inspect(debug.mock.calls, { depth: null });
            expect(messages).not.toContain(file);
            expect(messages).not.toContain(root);
        } finally {
            try {
                await dispose.dispose();
            } finally {
                debug.mockRestore();
                await rm(root, { recursive: true, force: true });
            }
        }
    });
});
