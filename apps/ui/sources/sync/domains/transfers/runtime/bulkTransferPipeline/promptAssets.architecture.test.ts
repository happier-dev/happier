import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_PROMPT_ASSET_TRANSFER_TOKENS = [
    'uploadMachineTransferJsonPayload',
    'downloadMachineTransferJsonPayload',
    'mergeTransferChunks',
    'chunkTransferClient',
    'apiSocket',
] as const;

const REQUIRED_PROMPT_ASSET_TRANSFER_TOKENS = [
    'bulkTransferPipeline',
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
