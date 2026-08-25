import { describe, expect, it } from 'vitest';

import { MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '@happier-dev/protocol';

import {
    SESSION_DRAFT_VALUE_SCHEMAS,
    SessionArmedAgentContinuationSubmissionCurrentnessSchema,
} from './sessionDraftValueTypes';

function attachment(index: number) {
    return {
        v: 1 as const,
        instanceId: `attachment-${index}`,
        attachment: { pluginId: 'acme.tasks', localId: 'task' },
        key: `task-${index}`,
        value: { id: String(index) },
        presentation: { label: `Task ${index}`, typeLabel: 'Task' },
    };
}

describe('session draft attachment bounds', () => {
    it('shares the Protocol attachment-instance limit and rejects one more', () => {
        const attachments = Array.from(
            { length: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 },
            (_unused, index) => attachment(index),
        );
        const attachmentDraftIds = attachments.map((entry) => entry.instanceId);
        const oneTooMany = [...attachments, attachment(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)];

        expect(SESSION_DRAFT_VALUE_SCHEMAS['structuredInput.composerAttachments'].safeParse(attachments).success)
            .toBe(true);
        expect(SESSION_DRAFT_VALUE_SCHEMAS['structuredInput.composerAttachments'].safeParse(oneTooMany).success)
            .toBe(false);
        expect(SessionArmedAgentContinuationSubmissionCurrentnessSchema.safeParse({
            text: '',
            mentions: [],
            composerAttachments: attachments,
            attachmentDraftIds,
        }).success).toBe(true);
        expect(SessionArmedAgentContinuationSubmissionCurrentnessSchema.safeParse({
            text: '',
            mentions: [],
            composerAttachments: oneTooMany,
            attachmentDraftIds: [...attachmentDraftIds, `attachment-${MAX_COMPOSER_ATTACHMENT_INSTANCES_V1}`],
        }).success).toBe(false);
    });
});
