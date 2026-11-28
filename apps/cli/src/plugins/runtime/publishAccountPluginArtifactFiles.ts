import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logger } from '@/ui/logger';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { PluginDiagnosticError } from './moduleFailure';

export async function publishAccountPluginArtifactFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const [relativePath, bytes] of files) {
        const path = join(root, relativePath);
        const directory = dirname(path);
        const pendingPath = join(directory, `.account-artifact-${randomUUID()}`);
        let existing: Buffer | undefined;
        try {
            await mkdir(directory, { recursive: true });
            await writeFile(pendingPath, bytes, { flag: 'wx' });
            try {
                // Publish complete bytes atomically and preserve any earlier publication.
                await link(pendingPath, path);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EEXIST') {
                    existing = await readFile(path);
                } else if (code === 'EPERM' || code === 'ENOTSUP') {
                    // This volume may not support hard links. Keep any existing
                    // bytes. Concurrent publishers for this verified digest carry
                    // identical bytes, so a same-directory rename is safe.
                    existing = await readFile(path).catch((readError: NodeJS.ErrnoException) => {
                        if (readError.code !== 'ENOENT') throw readError;
                        return undefined;
                    });
                    if (!existing) await rename(pendingPath, path);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            throw new PluginDiagnosticError({
                code: 'plugin_account_execution_artifact_unavailable',
                message: 'Could not write the selected plugin to the local artifact cache. Check that the cache is writable and try again.',
                details: { failureCause: projectActionFailureCauseV1(error, 'plugin.account_artifact.cache_publish') },
            });
        } finally {
            await rm(pendingPath, { force: true }).catch(() => {
                logger.debugLocalFile('[PLUGIN RUNTIME] Account artifact temporary file cleanup failed');
            });
        }
        if (existing && !existing.equals(bytes)) throw new Error('plugin_account_execution_cache_invalid');
    }
}
