import { createHash } from 'node:crypto';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

export async function hashWorkspaceFile(params: Readonly<{
    filePath: string;
    assertCanContinue?: () => void | Promise<void>;
}>): Promise<string> {
    const hash = createHash('sha256');
    // The exported workspace may be a Session's target: read it through the admitted source.
    // The scan classified this entry as a regular file, so a link here is a swap: never follow it.
    const file = await currentWorkspaceSource().open(params.filePath, { noFollow: true });
    try {
        await params.assertCanContinue?.();
        const chunk = Buffer.allocUnsafe(64 * 1024);
        for (let position = 0; ;) {
            const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            await params.assertCanContinue?.();
            hash.update(chunk.subarray(0, bytesRead));
            position += bytesRead;
        }
    } finally {
        await file.close();
    }

    return `sha256:${hash.digest('hex')}`;
}
