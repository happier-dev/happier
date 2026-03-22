import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_PROMPT_REGISTRY_TRANSFER_TOKENS = [
    'uploadMachineTransferJsonPayload',
    'downloadMachineTransferJsonPayload',
    'mergeTransferChunks',
    'chunkTransferClient',
    'apiSocket',
] as const;

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps prompt registry feature code free of legacy transfer plumbing outside the pipeline', async () => {
        const machinePromptRegistriesPath = new URL(
            '../../../../../sync/ops/machinePromptRegistries.ts',
            import.meta.url,
        );

        const machinePromptRegistriesSource = await readFile(machinePromptRegistriesPath, 'utf8');

        for (const token of FORBIDDEN_PROMPT_REGISTRY_TRANSFER_TOKENS) {
            expect(machinePromptRegistriesSource).not.toContain(token);
        }
    });
});
