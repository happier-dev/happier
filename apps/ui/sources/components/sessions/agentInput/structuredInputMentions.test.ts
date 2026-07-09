import { describe, expect, it } from 'vitest';

import {
    buildStructuredInputMetaOverrides,
    reconcileStructuredInputMentionsWithTextChange,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';

const vendorPluginMention = {
    kind: 'vendorPlugin',
    tokenText: '@gmail',
    start: 5,
    end: 11,
    vendorPluginRef: 'plugin://gmail@openai-curated',
    label: 'Gmail',
} satisfies ComposerStructuredInputMention;

const skillMention = {
    kind: 'skill',
    tokenText: '$review',
    start: 12,
    end: 19,
    name: 'review',
    path: '/skills/review/SKILL.md',
    displayName: 'Review',
    origin: 'vendor',
    projectionRef: 'codex-native:review',
    backendId: 'codex',
    agentId: 'codex-agent',
} satisfies ComposerStructuredInputMention;

describe('structured input mentions', () => {
    it('keeps a selected mention when text changes before the token', () => {
        const mentions = reconcileStructuredInputMentionsWithText({
            previousText: 'Call @gmail',
            nextText: 'Please Call @gmail',
            mentions: [vendorPluginMention],
        });

        expect(mentions).toEqual([
            expect.objectContaining({
                kind: 'vendorPlugin',
                start: 12,
                end: 18,
                vendorPluginRef: 'plugin://gmail@openai-curated',
            }),
        ]);
    });

    it('drops a selected mention when the token text is edited', () => {
        const mentions = reconcileStructuredInputMentionsWithText({
            previousText: 'Call @gmail',
            nextText: 'Call @gmai',
            mentions: [vendorPluginMention],
        });

        expect(mentions).toEqual([]);
    });

    it('uses selection-based reconciliation for large insertions before a mention', () => {
        const prefix = 'x'.repeat(300_000);
        const insertedText = '<div>/'.repeat(50_000);
        const previousText = `${prefix} @gmail tail`;
        const mention = {
            ...vendorPluginMention,
            start: prefix.length + 1,
            end: prefix.length + 7,
        } satisfies ComposerStructuredInputMention;
        const nextText = `${prefix} ${insertedText}@gmail tail`;

        const mentions = reconcileStructuredInputMentionsWithTextChange({
            previousText,
            nextText,
            previousSelection: { start: prefix.length + 1, end: prefix.length + 1 },
            mentions: [mention],
        });

        expect(mentions).toEqual([
            expect.objectContaining({
                kind: 'vendorPlugin',
                start: prefix.length + 1 + insertedText.length,
                end: prefix.length + 7 + insertedText.length,
            }),
        ]);
    });

    it('does not infer a manually typed vendor plugin token', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [],
            text: 'Call @gmail',
        });

        expect(meta).toEqual({});
    });

    it('builds one structured input envelope for selected vendor plugins and skills', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [vendorPluginMention, skillMention],
            text: 'Call @gmail $review',
        });

        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
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
                        origin: 'vendor',
                        projectionRef: 'codex-native:review',
                        backendId: 'codex',
                        agentId: 'codex-agent',
                    },
                ],
            },
        });
        expect(JSON.stringify(meta)).not.toContain('skill_content');
    });

    it('canonicalizes skill mention origins when writing structured input metadata', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [
                {
                    kind: 'skill',
                    tokenText: '$review',
                    start: 0,
                    end: 7,
                    name: 'review',
                    origin: 'codex_native',
                },
                {
                    kind: 'skill',
                    tokenText: '$summarize',
                    start: 8,
                    end: 18,
                    name: 'summarize',
                    origin: 'happier_projected',
                },
                {
                    kind: 'skill',
                    tokenText: '$plan',
                    start: 19,
                    end: 24,
                    name: 'plan',
                    origin: 'cursor_native',
                    backendId: 'cursor',
                },
            ],
            text: '$review $summarize $plan',
        });

        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                skillMentions: [
                    {
                        name: 'review',
                        origin: 'vendor',
                        backendId: 'codex',
                    },
                    {
                        name: 'summarize',
                        origin: 'happier',
                        projectionRef: 'happier_projected',
                    },
                    {
                        name: 'plan',
                        origin: 'vendor',
                        backendId: 'cursor',
                    },
                ],
            },
        });
        expect(JSON.stringify(meta)).not.toContain('codex_native');
        expect(JSON.stringify(meta)).not.toContain('cursor_native');
    });

    it('uses imageInputs as the structured image field', () => {
        const meta = buildStructuredInputMetaOverrides({
            attachments: [
                {
                    type: 'localImage',
                    kind: 'image',
                    localPath: '/tmp/happier/image.png',
                    path: '/tmp/happier/image.png',
                    mimeType: 'image/png',
                    name: 'image.png',
                    sizeBytes: 12,
                    sha256: 'hash',
                },
            ],
        });

        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
                imageInputs: [
                    {
                        type: 'localImage',
                        kind: 'image',
                        localPath: '/tmp/happier/image.png',
                        path: '/tmp/happier/image.png',
                        mimeType: 'image/png',
                        name: 'image.png',
                        sizeBytes: 12,
                        sha256: 'hash',
                    },
                ],
            },
        });
        expect(JSON.stringify(meta)).not.toContain('"attachments"');
    });
});
