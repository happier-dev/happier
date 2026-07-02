import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTurnInput } from './turnInput';

describe('buildCodexAppServerTurnInput', () => {
    it('builds text, vendor plugin mentions, skills, and images through one structured path', () => {
        const imagePath = '.happier/uploads/messages/m1/image.png';

        expect(buildCodexAppServerTurnInput({
            text: 'Use @gmail and $review',
            trustedLocalImagePaths: new Set([imagePath]),
            metadata: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: imagePath,
                                mimeType: 'image/png',
                            },
                        ],
                    },
                },
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        {
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            label: 'Gmail',
                        },
                    ],
                    skillMentions: [
                        {
                            name: 'review',
                            path: '/skills/review/SKILL.md',
                            displayName: 'Review',
                        },
                    ],
                    imageInputs: [
                        {
                            kind: 'localImage',
                            mimeType: 'image/png',
                            path: imagePath,
                            provenance: { kind: 'sessionAttachmentUpload' },
                        },
                        {
                            kind: 'image',
                            mimeType: 'image/png',
                            url: 'https://example.test/image.png',
                        },
                    ],
                },
            },
        })).toEqual([
            { type: 'text', text: 'Use @gmail and $review' },
            { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
            { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
            { type: 'localImage', path: imagePath },
            { type: 'image', url: 'https://example.test/image.png' },
        ]);
    });

    it('rejects untrusted local image paths from structured metadata', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'crafted',
            metadata: {
                happierStructuredInputV1: {
                    v: 1,
                    attachments: [
                        {
                            kind: 'image',
                            mimeType: 'image/png',
                            localPath: '/etc/passwd',
                            path: '/tmp/private.png',
                        },
                    ],
                },
            },
        })).toEqual([{ type: 'text', text: 'crafted' }]);
    });

    it('accepts protocol image attachment types without requiring kind or mimeType', () => {
        const localPath = '.happier/uploads/messages/m2/local.png';

        expect(buildCodexAppServerTurnInput({
            text: 'typed images',
            trustedLocalImagePaths: new Set([localPath]),
            metadata: {
                happierStructuredInputV1: {
                    v: 1,
                    attachments: [
                        { type: 'image', url: 'https://example.test/typed.png' },
                        { type: 'localImage', localPath, provenance: { kind: 'sessionAttachmentUpload' } },
                    ],
                },
            },
        })).toEqual([
            { type: 'text', text: 'typed images' },
            { type: 'image', url: 'https://example.test/typed.png' },
            { type: 'localImage', path: localPath },
        ]);
    });

    it('passes fallback plugin and skill metadata without injecting raw skill contents', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'fallback',
            metadata: {
                happierVendorPluginMentions: [
                    { vendorPluginRef: 'plugin://notion@openai-curated', label: 'Notion' },
                ],
                happierSkillMentions: [
                    { name: 'docs', path: '/skills/docs/SKILL.md', content: 'do not forward' },
                    { name: 'ignored-without-path' },
                ],
            },
        })).toEqual([
            { type: 'text', text: 'fallback' },
            { type: 'mention', name: 'Notion', path: 'plugin://notion@openai-curated' },
            { type: 'skill', name: 'docs', path: '/skills/docs/SKILL.md' },
        ]);
    });
});
