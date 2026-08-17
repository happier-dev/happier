import { describe, expect, it } from 'vitest';

import { buildCodexAppServerTurnInput } from './turnInput';

const UPLOAD_PATH = '.happier/uploads/messages/m1/image.png';

describe('buildCodexAppServerTurnInput', () => {
    it('projects vendor plugin mentions, skills, and verified images from the structured input envelope', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'Use @gmail and $review',
            structuredInput: {
                v: 1,
                vendorPluginMentions: [
                    {
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        label: 'Gmail',
                    },
                ],
                skillMentions: [
                    {
                        id: 'review',
                        name: 'review',
                        path: '/skills/review/SKILL.md',
                        displayName: 'Review',
                    },
                ],
                imageInputs: [
                    {
                        id: `localImage:${UPLOAD_PATH}`,
                        kind: 'localImage',
                        mimeType: 'image/png',
                        path: UPLOAD_PATH,
                        provenance: { kind: 'sessionAttachmentUpload' },
                    },
                    {
                        id: 'image:https://example.test/image.png',
                        kind: 'image',
                        mimeType: 'image/png',
                        url: 'https://example.test/image.png',
                    },
                ],
            },
        })).toEqual([
            { type: 'text', text: 'Use @gmail and $review' },
            { type: 'mention', name: 'Gmail', path: 'plugin://gmail@openai-curated' },
            { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
            { type: 'localImage', path: UPLOAD_PATH },
            { type: 'image', url: 'https://example.test/image.png' },
        ]);
    });

    it('accepts protocol image attachment types without requiring kind or mimeType', () => {
        const localPath = '.happier/uploads/messages/m2/local.png';

        expect(buildCodexAppServerTurnInput({
            text: 'typed images',
            structuredInput: {
                v: 1,
                attachments: [
                    { id: 'remote', type: 'image', url: 'https://example.test/typed.png' },
                    {
                        id: 'local',
                        type: 'localImage',
                        localPath,
                        provenance: { kind: 'sessionAttachmentUpload' },
                    },
                ],
            },
        })).toEqual([
            { type: 'text', text: 'typed images' },
            { type: 'image', url: 'https://example.test/typed.png' },
            { type: 'localImage', path: localPath },
        ]);
    });

    it('drops local image inputs that are not uploaded session attachments', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'crafted',
            structuredInput: {
                v: 1,
                attachments: [
                    {
                        id: 'crafted',
                        kind: 'image',
                        mimeType: 'image/png',
                        localPath: '/etc/passwd',
                        path: '/tmp/private.png',
                    },
                ],
            },
        })).toEqual([{ type: 'text', text: 'crafted' }]);
    });

    it('drops local image inputs that do not carry session attachment upload provenance', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'unstamped',
            structuredInput: {
                v: 1,
                imageInputs: [
                    {
                        id: `localImage:${UPLOAD_PATH}`,
                        kind: 'localImage',
                        mimeType: 'image/png',
                        path: UPLOAD_PATH,
                    },
                ],
            },
        })).toEqual([{ type: 'text', text: 'unstamped' }]);
    });

    it('skips skill mentions without a resolvable path so no raw skill content is forwarded', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'fallback',
            structuredInput: {
                v: 1,
                skillMentions: [
                    { id: 'docs', name: 'docs', path: '/skills/docs/SKILL.md', content: 'do not forward' },
                    { id: 'ignored', name: 'ignored-without-path' },
                ],
            },
        })).toEqual([
            { type: 'text', text: 'fallback' },
            { type: 'skill', name: 'docs', path: '/skills/docs/SKILL.md' },
        ]);
    });

    it('ignores execution run intent payloads carried on the same runtime input field', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'review the working tree',
            structuredInput: {
                v: 2,
                changeType: 'uncommitted',
                engines: { coderabbit: { plain: true } },
            },
        })).toEqual([{ type: 'text', text: 'review the working tree' }]);
    });

    it('returns the text item when no structured input is supplied', () => {
        expect(buildCodexAppServerTurnInput({ text: 'plain' })).toEqual([
            { type: 'text', text: 'plain' },
        ]);
    });

    it('emits exactly one item per reference when an envelope carries both shapes (D-4)', () => {
        // A dual-written envelope repeats each reference in `mentions[]` and in the legacy
        // per-kind array. Without precedence the concatenation would send both to Codex.
        expect(buildCodexAppServerTurnInput({
            text: 'Use @gmail and $review',
            structuredInput: {
                v: 1,
                mentions: [
                    {
                        kind: 'happier.vendorPlugin',
                        ref: 'vendorPlugin:plugin://gmail@openai-curated',
                        token: '@gmail',
                        start: 4,
                        end: 10,
                    },
                    { kind: 'happier.skill', ref: 'skill:vendor:codex:review', token: '$review', start: 15, end: 22 },
                ],
                vendorPluginMentions: [{ vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' }],
                skillMentions: [{ id: 'review', name: 'review', path: '/skills/review/SKILL.md' }],
            },
        })).toEqual([{ type: 'text', text: 'Use @gmail and $review' }]);
    });

    it('still reads the legacy arrays when the envelope carries no mentions', () => {
        expect(buildCodexAppServerTurnInput({
            text: 'Use $review',
            structuredInput: {
                v: 1,
                skillMentions: [{ id: 'review', name: 'review', path: '/skills/review/SKILL.md' }],
            },
        })).toEqual([
            { type: 'text', text: 'Use $review' },
            { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
        ]);
    });
});
