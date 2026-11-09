import { describe, expect, it } from 'vitest';

import { resolveMessageComposerAttachments } from './messageComposerAttachments';
import { resolveMessageStructuredReferences } from '../references/messageStructuredReferences';

function persistedAttachment(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        v: 1,
        instanceId: 'instance-1',
        attachment: { pluginId: 'com.acme.review', localId: 'review' },
        key: 'review-42',
        value: { reviewId: '42', apiToken: 'secret-token' },
        presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
        ...overrides,
    };
}

describe('message composer attachment transcript projection', () => {
    it('projects the annotation excerpt, note and immutable source independently of its plugin value', () => {
        const source = { kind: 'session', session: { serverId: 'home-a', sessionId: 'session-a' }, messageId: 'committed-a' };
        const [projected] = resolveMessageComposerAttachments({ happierStructuredInputV1: { v: 1, composerAttachments: [
            persistedAttachment({ presentation: { label: 'Selected passage', typeLabel: 'Annotation', description: 'Clarify this', source } }),
        ] } });
        expect(projected).toMatchObject({ label: 'Selected passage', description: 'Clarify this', source });
        expect(JSON.stringify(projected)).not.toContain('secret-token');
    });

    it('keeps only unplaced or legacy fallbacks when the canonical projection draws an attachment inline', () => {
        const meta = { happierStructuredInputV1: { v: 1, composerAttachments: [
            persistedAttachment(), persistedAttachment({ instanceId: 'unplaced' }),
        ] } };
        const projection = resolveMessageStructuredReferences({ text: '[Review #42](happier-ref:attachment:instance-1)', meta });
        expect(resolveMessageComposerAttachments(meta, projection.inline).map(item => item.instanceId)).toEqual(['unplaced']);
        expect(resolveMessageComposerAttachments(meta).map(item => item.instanceId)).toEqual(['instance-1', 'unplaced']);
        const mediaMeta = { happierStructuredInputV1: { v: 1, composerAttachments: [
            persistedAttachment({ content: { kind: 'sessionMedia', mediaId: 'media-1' } }),
        ] } };
        const mediaProjection = resolveMessageStructuredReferences({ text: '[Review #42](happier-ref:attachment:instance-1)', meta: mediaMeta });
        expect(resolveMessageComposerAttachments(mediaMeta, mediaProjection.inline)).toEqual([]);
        const code = resolveMessageStructuredReferences({ text: '`[Review #42](happier-ref:attachment:instance-1)`', meta });
        expect(resolveMessageComposerAttachments(meta, code.inline).map(item => item.instanceId)).toEqual(['instance-1', 'unplaced']);
    });
    it('renders only the flat persisted presentation the author supplied at admission', () => {
        // The transcript is read long after the authoring plugin may have been
        // uninstalled, so the row it shows must be reconstructable from the
        // persisted bytes alone — no catalog entry, no resolver, no value.
        const attachments = resolveMessageComposerAttachments({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [
                    persistedAttachment(),
                    persistedAttachment({
                        instanceId: 'instance-2',
                        key: 'review-43',
                        presentation: {
                            label: 'Review #43',
                            typeLabel: 'Review comment',
                            description: 'Second pass',
                            tone: 'warning',
                        },
                    }),
                ],
            },
        });

        expect(attachments).toEqual([
            {
                instanceId: 'instance-1',
                typeLabel: 'Review comment',
                label: 'Review #42',
                description: null,
                icon: 'info',
                tone: null,
            },
            {
                instanceId: 'instance-2',
                typeLabel: 'Review comment',
                label: 'Review #43',
                description: 'Second pass',
                icon: null,
                tone: 'warning',
            },
        ]);
    });

    it('never carries the attachment value or its authoring identity into the transcript', () => {
        const [projected] = resolveMessageComposerAttachments({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [persistedAttachment()],
            },
        });

        expect(Object.keys(projected ?? {}).sort())
            .toEqual(['description', 'icon', 'instanceId', 'label', 'tone', 'typeLabel']);
        expect(JSON.stringify(projected)).not.toContain('secret-token');
    });

    it('fails closed when persisted attachments are malformed', () => {
        expect(resolveMessageComposerAttachments({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{ instanceId: 'not-an-attachment' }],
            },
        })).toEqual([]);
    });
});
