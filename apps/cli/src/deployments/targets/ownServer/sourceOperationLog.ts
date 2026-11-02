import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionExecutorContext, WorkspaceManifestEntry } from '@happier-dev/protocol';
import { ensureProtectedLocalStateDirectory, openProtectedLocalStateFile } from '@/utils/fs/protectedLocalState';
import type { OwnServerDeploymentStageLogWriter } from './stageLog';

export type DeploymentSourceProgress = 'export' | 'materialize';

/** These closed phase facts contain no source paths, contents or native output.
 * The operation file is already open before export; no buffered copy is needed. */
export async function recordDeploymentSourceProgress(output: Pick<OwnServerDeploymentStageLogWriter, 'appendRedacted' | 'assertWritten' | 'beginStep'>,
    context: Pick<ActionExecutorContext, 'operationProgress'>, phase: DeploymentSourceProgress): Promise<void> {
    await output.beginStep({ stepId: 'source' });
    const label = phase === 'export' ? 'Exporting exact source' : 'Materializing exact source';
    output.appendRedacted('stdout', Buffer.from(`${label}\n`));
    output.assertWritten();
    context.operationProgress?.update({ phase: 'sync', label });
}

const refuse = (): never => { throw Object.assign(new Error('Deployment stage log custody changed'), { code: 'deployment_log_unavailable' }); };

/** Host-only admission for the materializer's one retained file. It grants no
 * authority to replace an existing source tree or write into a reoccupied root. */
export async function createDeploymentSourceOperationLogCustody(input: Readonly<{
    targetPath: string; entries: readonly WorkspaceManifestEntry[];
}>) {
    const relativePath = '.happier/deploy.log';
    if (input.entries.some(entry => {
        const path = entry.relativePath.replaceAll('\\', '/');
        return path === relativePath || path.startsWith(`${relativePath}/`) || path === '.happier' && entry.kind !== 'directory';
    })) return refuse();
    const directory = join(input.targetPath, '.happier');
    const path = join(directory, 'deploy.log');
    const assertRetainedFile = async () => {
        await ensureProtectedLocalStateDirectory(input.targetPath, { authority: 'admitted', createIfMissing: false });
        await ensureProtectedLocalStateDirectory(directory, { authority: 'admitted', createIfMissing: false });
        const file = await openProtectedLocalStateFile(path, 'r');
        await file.close();
    };
    const assertInitialTarget = async () => {
        await assertRetainedFile();
        const rootEntries = await readdir(input.targetPath);
        const logEntries = await readdir(directory);
        if (rootEntries.length !== 1 || rootEntries[0] !== '.happier'
            || logEntries.length !== 1 || logEntries[0] !== 'deploy.log') return refuse();
    };
    await assertInitialTarget();
    return { relativePath, assertInitialTarget, assertRetainedFile };
}
