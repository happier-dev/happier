import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_FILE_TRANSFER_TOKENS = [
    'createSessionFileTransferRpcCaller',
    'DAEMON_SESSION_FILES_',
    'mergeTransferChunks',
] as const;

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps session file feature code free of transfer plumbing outside the pipeline', async () => {
        const useWorkspaceFileTransfersPath = new URL(
            '../../../../../hooks/session/files/useWorkspaceFileTransfers.ts',
            import.meta.url,
        );
        const fileReadWritePath = new URL(
            '../../../../../sync/ops/sessionFileSystem/fileReadWrite.ts',
            import.meta.url,
        );

        const [useWorkspaceFileTransfersSource, fileReadWriteSource] = await Promise.all([
            readFile(useWorkspaceFileTransfersPath, 'utf8'),
            readFile(fileReadWritePath, 'utf8'),
        ]);

        for (const token of FORBIDDEN_SESSION_FILE_TRANSFER_TOKENS) {
            expect(useWorkspaceFileTransfersSource).not.toContain(token);
            expect(fileReadWriteSource).not.toContain(token);
        }
    });
});
