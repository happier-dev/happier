import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_ATTACHMENT_TRANSFER_TOKENS = [
    'apiSocket',
    'uploadBulkPayloadFromFile',
    'resolveBulkTransferPolicyAndRoute',
    'daemon.sessionAttachments.upload.',
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
    });
});
