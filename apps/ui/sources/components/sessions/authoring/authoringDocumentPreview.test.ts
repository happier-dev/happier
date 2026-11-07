import { describe, expect, it } from 'vitest';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { projectAuthoringDocumentPreview } from './authoringDocumentPreview';

describe('authored reference preview', () => {
    it('keeps the host owner’s ready, out-of-scope and removed token states', () => {
        const references = ['Ready', 'Out of scope', 'Removed'].map((label, index) => {
            const reference = { kind: MENTION_KIND_V1.workflowInput, ref: `workflowInput:${index}`, label };
            return { ...reference, token: formatInlineReferenceTokenV1(reference) };
        });
        const text = references.map(reference => reference.token).join(' ');
        const states = new Map([
            ['workflowInput:0', 'ready' as const], ['workflowInput:1', 'unavailable' as const], ['workflowInput:2', 'removed' as const],
        ]);
        expect(projectAuthoringDocumentPreview({ text, references }, null, states).references.map(reference => reference.state))
            .toEqual(['ready', 'unavailable', 'removed']);
    });
});
