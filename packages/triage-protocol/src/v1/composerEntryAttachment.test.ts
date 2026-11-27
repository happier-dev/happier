import { describe, expect, it } from 'vitest';

import { TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1, readTriageEntryComposerAttachmentRefV1 } from './composerEntryAttachment.js';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from './identity.js';

describe('Triage composer attachment sharing', () => {
    it('qualifies the author’s personal task and projects only the shared identity', () => {
        const source = INTERNAL_TASK_SOURCE_V1;
        const record = {
            attachment: TRIAGE_ENTRY_ATTACHMENT_IDENTITY_V1,
            presentation: { label: 'Private task title' },
            value: {
                v: 1,
                entryRef: { source, ...internalTaskLocalRefV1('task-42') },
                sourceInstance: { source, sourceInstanceId: '9b92a454-7203-4b67-a55e-07ea947f8022' },
                lastKnownLocator: { v: 1, routingToken: 'private-route' },
            },
        };
        expect(readTriageEntryComposerAttachmentRefV1(record, 'author')).toEqual({
            source, ...internalTaskLocalRefV1('task-42', 'author'),
        });
        expect(readTriageEntryComposerAttachmentRefV1({ ...record, attachment: { pluginId: 'acme.issues', localId: 'entry' } }, 'author'))
            .toBeNull();
        expect(readTriageEntryComposerAttachmentRefV1(record, '')).toBeNull();
    });
});
