import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_PROMPT_ASSET_TRANSFER_TOKENS = [
    'uploadMachineTransferJsonPayload',
    'downloadMachineTransferJsonPayload',
    'mergeTransferChunks',
    'chunkTransferClient',
    'apiSocket',
    'RPC_METHODS',
    'machineRpcWithServerScope',
    'DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT',
    'DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK',
    'DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE',
    'DAEMON_PROMPT_ASSETS_UPLOAD_INIT',
    'DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK',
    'DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE',
    'DAEMON_PROMPT_ASSETS_LIST_TYPES',
    'DAEMON_PROMPT_ASSETS_DISCOVER',
    'DAEMON_PROMPT_ASSETS_DELETE',
    'bulkTransferPipeline/daemonPromptAssets',
] as const;

const REQUIRED_PROMPT_ASSET_TRANSFER_TOKENS = [
    "@/sync/domains/transfers/runtime/bulkTransferPipeline",
] as const;

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps prompt asset feature code free of legacy transfer plumbing outside the pipeline', async () => {
        const machinePromptAssetsPath = new URL(
            '../../../../../sync/ops/machinePromptAssets.ts',
            import.meta.url,
        );

        const machinePromptAssetsSource = await readFile(machinePromptAssetsPath, 'utf8');

        for (const token of FORBIDDEN_PROMPT_ASSET_TRANSFER_TOKENS) {
            expect(machinePromptAssetsSource).not.toContain(token);
        }

        for (const token of REQUIRED_PROMPT_ASSET_TRANSFER_TOKENS) {
            expect(machinePromptAssetsSource).toContain(token);
        }
    });
});
