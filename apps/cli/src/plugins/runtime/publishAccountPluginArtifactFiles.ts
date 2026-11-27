import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logger } from '@/ui/logger';

export async function publishAccountPluginArtifactFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const [relativePath, bytes] of files) {
        const path = join(root, relativePath);
        const directory = dirname(path);
        await mkdir(directory, { recursive: true });
        const pendingPath = join(directory, `.account-artifact-${randomUUID()}`);
        try {
            await writeFile(pendingPath, bytes, { flag: 'wx' });
            try {
                // Publish complete bytes atomically and preserve any earlier publication.
                await link(pendingPath, path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (!(await readFile(path)).equals(bytes)) throw new Error('plugin_account_execution_cache_invalid');
            }
        } finally {
            await rm(pendingPath, { force: true }).catch(() => {
                logger.debugLocalFile('[PLUGIN RUNTIME] Account artifact temporary file cleanup failed');
            });
        }
    }
}
