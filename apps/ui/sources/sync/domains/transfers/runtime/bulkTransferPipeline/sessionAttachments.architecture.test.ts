import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_ATTACHMENT_TRANSFER_TOKENS = [
    'apiSocket',
    'uploadBulkPayloadFromFile',
    'resolveBulkTransferPolicyAndRoute',
    'daemon.bulkTransfer.upload.',
    // Attachment feature code must not own fallback routing.
    'sessionMachineRpcFallback',
    'bulkTransferPipeline/daemonSessionAttachments',
] as const;

const REQUIRED_SESSION_ATTACHMENT_TRANSFER_TOKENS = [
    "@/sync/domains/transfers/runtime/bulkTransferPipeline",
] as const;

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps attachment feature code free of transfer plumbing outside the pipeline', async () => {
        const uploadSessionAttachmentPath = new URL(
            '../../../../../sync/domains/transfers/ops/uploadSessionAttachment.ts',
            import.meta.url,
        );

        const uploadSessionAttachmentSource = await readFile(uploadSessionAttachmentPath, 'utf8');

        for (const token of FORBIDDEN_SESSION_ATTACHMENT_TRANSFER_TOKENS) {
            expect(uploadSessionAttachmentSource).not.toContain(token);
        }

        for (const token of REQUIRED_SESSION_ATTACHMENT_TRANSFER_TOKENS) {
            expect(uploadSessionAttachmentSource).toContain(token);
        }
    });
});
