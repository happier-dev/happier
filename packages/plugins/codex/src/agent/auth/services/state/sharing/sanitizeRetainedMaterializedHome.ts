import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_DEFINITION } from '../../../../definition.js';

/** Drops Codex's reconstructible curated marketplace once the native home has stopped. */
export async function sanitizeCodexRetainedMaterializedHome(identityRoot: string): Promise<void> {
    const codexHome = join(identityRoot, AGENT_DEFINITION.id);
    const temporaryDirectory = join(codexHome, '.tmp');
    try {
        if (!(await lstat(codexHome)).isDirectory() || !(await lstat(temporaryDirectory)).isDirectory()) return;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
    }
    // Keep rollout state, installed plugins and other Codex scratch entries.
    await rm(join(temporaryDirectory, 'plugins'), { recursive: true, force: true });
}
