import { describe, expect, it } from 'vitest';

import { resolveNewSessionDraftAttachmentFlowId } from './newSessionDraftAttachmentFlowId';

describe('resolveNewSessionDraftAttachmentFlowId', () => {
    it('keys local attachment sidecars by the exact new-session draft address', () => {
        expect(resolveNewSessionDraftAttachmentFlowId('8e0a5dd1-b1df-43dd-b51e-b7787b30362e')).toBe(
            'draft:8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
        );
        expect(resolveNewSessionDraftAttachmentFlowId('5f70a446-6688-4f50-b599-a017b285b7f1')).not.toBe(
            resolveNewSessionDraftAttachmentFlowId('8e0a5dd1-b1df-43dd-b51e-b7787b30362e'),
        );
    });
});
