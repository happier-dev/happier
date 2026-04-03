import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_FILE_TRANSFER_TOKENS = [
    'createSessionFileTransferRpcCaller',
    'DAEMON_BULK_TRANSFER_',
    'mergeTransferChunks',
    // Feature code should not implement or import transfer routing; policy and route selection
    // live in the canonical pipeline/runtime layers.
] as const;

const REQUIRED_WORKSPACE_FILE_TRANSFER_TOKENS = [
    "@/sync/domains/transfers/runtime/bulkTransferPipeline",
] as const;

const REQUIRED_SESSION_FILE_TRANSFER_TOKENS = [
    "@/hooks/workspaces/transfers/useWorkspaceFileTransfers",
] as const;

const REQUIRED_SESSION_FILE_READ_WRITE_TOKENS = [
    "@/sync/ops/workspaceFileSystem",
] as const;

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps session file feature code free of transfer plumbing outside the pipeline', async () => {
        const useWorkspaceFileTransfersPath = new URL(
            '../../../../../hooks/session/files/useWorkspaceFileTransfers.ts',
            import.meta.url,
        );
        const workspaceFileTransfersPath = new URL(
            '../../../../../hooks/workspaces/transfers/useWorkspaceFileTransfers.ts',
            import.meta.url,
        );
        const fileReadWritePath = new URL(
            '../../../../../sync/ops/sessionFileSystem/fileReadWrite.ts',
            import.meta.url,
        );
        const workspaceFileReadWritePath = new URL(
            '../../../../../sync/ops/workspaceFileSystem/fileReadWrite.ts',
            import.meta.url,
        );

        const [useWorkspaceFileTransfersSource, workspaceFileTransfersSource, fileReadWriteSource, workspaceFileReadWriteSource] = await Promise.all([
            readFile(useWorkspaceFileTransfersPath, 'utf8'),
            readFile(workspaceFileTransfersPath, 'utf8'),
            readFile(fileReadWritePath, 'utf8'),
            readFile(workspaceFileReadWritePath, 'utf8'),
        ]);

        for (const token of FORBIDDEN_SESSION_FILE_TRANSFER_TOKENS) {
            expect(useWorkspaceFileTransfersSource).not.toContain(token);
            expect(workspaceFileTransfersSource).not.toContain(token);
            expect(fileReadWriteSource).not.toContain(token);
            expect(workspaceFileReadWriteSource).not.toContain(token);
        }

        for (const token of REQUIRED_WORKSPACE_FILE_TRANSFER_TOKENS) {
            expect(workspaceFileTransfersSource).toContain(token);
            expect(workspaceFileReadWriteSource).toContain(token);
        }

        for (const token of REQUIRED_SESSION_FILE_TRANSFER_TOKENS) {
            expect(useWorkspaceFileTransfersSource).toContain(token);
        }

        for (const token of REQUIRED_SESSION_FILE_READ_WRITE_TOKENS) {
            expect(fileReadWriteSource).toContain(token);
        }
    });
});
