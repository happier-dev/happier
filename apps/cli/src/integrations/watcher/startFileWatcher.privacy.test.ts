import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        const dispose = startFileWatcher(file, onChange, { emitInitial: false });

        await new Promise((resolve) => setTimeout(resolve, 100));
        await appendFile(file, '{}\n', 'utf8');
        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

        const messages = debug.mock.calls.map(([message]) => String(message));
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.join('\n')).not.toContain(file);
        expect(messages.join('\n')).not.toContain(root);

        dispose();
        debug.mockRestore();
    });

    it('redacts watched paths from watcher failure logging', async () => {
        const root = await mkdtemp(join(tmpdir(), 'file-watcher-error-privacy-'));
        const file = join(root, 'private-session.jsonl');
        await writeFile(file, '{}\n', 'utf8');
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        let attempts = 0;
        const dispose = startFileWatcher(file, async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error(`failed to read ${file}`);
            }
        }, { emitInitial: false });

        await new Promise((resolve) => setTimeout(resolve, 100));
        await appendFile(file, '{}\n', 'utf8');
        await vi.waitFor(() => {
            expect(debug.mock.calls.some(([message]) =>
                String(message).includes('Watch error'))).toBe(true);
        });

        const messages = debug.mock.calls.map(([message]) => String(message));
        expect(messages.join('\n')).not.toContain(file);
        expect(messages.join('\n')).not.toContain(root);

        dispose();
        debug.mockRestore();
    });
});
