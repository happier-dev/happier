import { describe, expect, it } from 'vitest';

import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
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

// `origin` is what the skill catalog actually emits (`SessionSkillCatalogItemV1Schema` makes it
// required), and it is the field the canonical identity is folded from: `codex_native` becomes
// `(origin: vendor, backendId: codex)`, so the reference is `skill:vendor:codex:review`.
const skillMention = {
    kind: 'skill',
    tokenText: '$review',
    start: 12,
    end: 19,
    name: 'review',
    path: '/skills/review/SKILL.md',
    displayName: 'Review',
    origin: 'codex_native',
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

    it('filters selected mentions again when building message metadata', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [vendorPluginMention],
            text: 'Call @gmai',
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
                        origin: 'codex_native',
                    },
                ],
            },
        });
        expect(JSON.stringify(meta)).not.toContain('skill_content');
    });

    describe('EU-6 dual writing', () => {
        function readEnvelope(meta: Record<string, unknown>): Record<string, any> {
            return (meta.happierStructuredInputV1 ?? {}) as Record<string, any>;
        }

        it('writes mentions[] as canonical and the legacy arrays as its projection', () => {
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [vendorPluginMention, skillMention],
                text: 'Call @gmail $review',
            }));

            expect(envelope.mentions).toEqual([
                {
                    kind: 'happier.vendorPlugin',
                    ref: 'vendorPlugin:plugin://gmail@openai-curated',
                    token: '@gmail',
                    start: 5,
                    end: 11,
                    label: 'Gmail',
                },
                {
                    kind: 'happier.skill',
                    ref: 'skill:vendor:codex:review',
                    token: '$review',
                    start: 12,
                    end: 19,
                    label: 'Review',
                },
            ]);
            // Same membership, same order, one legacy record per reference.
            expect(envelope.vendorPluginMentions).toHaveLength(1);
            expect(envelope.skillMentions).toHaveLength(1);
        });

        it('derives the skill reference from the catalog identity, never from the path', () => {
            const moved = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [{ ...skillMention, path: '/somewhere/else/SKILL.md' }],
                text: 'Call @gmail $review',
            }));

            expect(moved.mentions[0].ref).toBe('skill:vendor:codex:review');
            expect(JSON.stringify(moved.mentions)).not.toContain('SKILL.md');
        });

        it('writes a session reference as a RELATIVE `session:<id>` carrying the id, never the title (EU-7/D-8)', () => {
            // D-8 is binding: the reference has no authority component, because the nearest
            // server-scope owner falls back to a device-local profile id which must never
            // enter a persisted, cross-device reference. And the identity is the session id,
            // so the reference still resolves after the referenced session is renamed — the
            // label is an insert-time display snapshot only.
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [{
                    kind: 'session',
                    tokenText: '@session:fix-startup-v4a0a7',
                    start: 0,
                    end: 27,
                    sessionId: 'cmslj08960ku1tmhrd0v4a0a7',
                    label: 'Fix Detached Dev Stack Startup',
                }],
                text: '@session:fix-startup-v4a0a7 look at this',
            }));

            expect(envelope.mentions).toEqual([{
                kind: 'happier.session',
                ref: 'session:cmslj08960ku1tmhrd0v4a0a7',
                token: '@session:fix-startup-v4a0a7',
                start: 0,
                end: 27,
                label: 'Fix Detached Dev Stack Startup',
            }]);
            expect(envelope.mentions[0].ref).not.toContain('//');
            expect(envelope.mentions[0].ref).not.toContain('Fix Detached');
            // Sessions have no legacy per-kind array, so dual writing adds none.
            expect(envelope.vendorPluginMentions).toBeUndefined();
            expect(envelope.skillMentions).toBeUndefined();
        });

        it('emits exactly one provider reference per unique {kind, ref} (D-26)', () => {
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [
                    { ...vendorPluginMention, tokenText: '@gmail', start: 0, end: 6 },
                    { ...vendorPluginMention, tokenText: '@gmail', start: 7, end: 13 },
                ],
                text: '@gmail @gmail',
            }));

            // Every textual occurrence stays in mentions[] because range reconciliation needs
            // it; provider context is deduplicated by {kind, ref} and ordered by first use.
            expect(envelope.mentions).toHaveLength(2);
            expect(envelope.vendorPluginMentions).toEqual([
                { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
            ]);
        });

        it('keeps the message on the legacy shape when a mention has no derivable identity', () => {
            // A skill whose catalog origin this build cannot fold has no canonical identity, so
            // the host could not resolve a reference to it either. Writing mentions[] anyway
            // would make D-4's precedence rule hide it: readers that find mentions ignore the
            // legacy arrays entirely.
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [vendorPluginMention, { ...skillMention, origin: 'unknown_origin' }],
                text: 'Call @gmail $review',
            }));

            expect(envelope.mentions).toBeUndefined();
            expect(envelope.vendorPluginMentions).toHaveLength(1);
            expect(envelope.skillMentions).toEqual([
                {
                    name: 'review',
                    path: '/skills/review/SKILL.md',
                    displayName: 'Review',
                    origin: 'unknown_origin',
                },
            ]);
        });

        it('transmits a newer build\'s reference kind inertly (INV-4)', () => {
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [{
                    kind: 'happier.futureThing',
                    ref: 'futureThing:abc',
                    tokenText: '@future:abc',
                    start: 0,
                    end: 11,
                }],
                text: '@future:abc',
            }));

            expect(envelope.mentions).toEqual([
                { kind: 'happier.futureThing', ref: 'futureThing:abc', token: '@future:abc', start: 0, end: 11 },
            ]);
            expect(envelope.vendorPluginMentions).toBeUndefined();
            expect(envelope.skillMentions).toBeUndefined();
        });

        it('keeps mentions[] when an attachment envelope is merged into it', () => {
            const merged = mergeMessageMetaOverrides(
                buildStructuredInputMetaOverrides({
                    mentions: [vendorPluginMention],
                    text: 'Call @gmail',
                }),
                buildStructuredInputMetaOverrides({
                    attachments: [{ type: 'image', url: 'https://example.test/a.png' }],
                }),
            );

            expect(readEnvelope(merged ?? {}).mentions).toHaveLength(1);
            expect(readEnvelope(merged ?? {}).attachments).toHaveLength(1);
        });
    });

    it('leaves a mention alone when text is inserted after its token', () => {
        expect(reconcileStructuredInputMentionsWithText({
            previousText: 'Call @gmail',
            nextText: 'Call @gmail now',
            mentions: [vendorPluginMention],
        })).toEqual([expect.objectContaining({ start: 5, end: 11 })]);
    });

    it('shifts every following mention when a selection before them is replaced', () => {
        // 'Call ' -> 'Hey ': one code unit shorter, so both tokens move back by one.
        expect(reconcileStructuredInputMentionsWithTextChange({
            previousText: 'Call @gmail$review',
            nextText: 'Hey @gmail$review',
            previousSelection: { start: 0, end: 5 },
            mentions: [
                { ...vendorPluginMention, start: 5, end: 11 },
                { ...skillMention, start: 11, end: 18 },
            ],
        })).toEqual([
            expect.objectContaining({ kind: 'vendorPlugin', start: 4, end: 10 }),
            expect.objectContaining({ kind: 'skill', start: 10, end: 17 }),
        ]);
    });

    it('shifts a mention by UTF-16 code units when a surrogate pair is inserted before it', () => {
        // A single astral code point occupies two UTF-16 code units, which is the unit the
        // range contract and `String.prototype.slice` both use.
        expect(reconcileStructuredInputMentionsWithText({
            previousText: 'Call @gmail',
            nextText: 'Call \u{1F600}@gmail',
            mentions: [vendorPluginMention],
        })).toEqual([expect.objectContaining({ start: 7, end: 13 })]);
    });

    it('reconciles a mention of an unknown kind through the same generic path (INV-4)', () => {
        const unknownMention = {
            kind: 'happier.session',
            tokenText: '@session:abc',
            start: 5,
            end: 17,
        } satisfies ComposerStructuredInputMention;

        expect(reconcileStructuredInputMentionsWithText({
            previousText: 'Call @session:abc',
            nextText: 'Please Call @session:abc',
            mentions: [unknownMention],
        })).toEqual([expect.objectContaining({ kind: 'happier.session', start: 12, end: 24 })]);

        expect(reconcileStructuredInputMentionsWithText({
            previousText: 'Call @session:abc',
            nextText: 'Call @session:ab',
            mentions: [unknownMention],
        })).toEqual([]);
    });

    it('never projects an unknown kind into a legacy per-kind array', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [{
                kind: 'happier.session',
                tokenText: '@session:abc',
                start: 5,
                end: 17,
            }],
            text: 'Call @session:abc',
        });

        expect(meta).toEqual({});
    });

    it('uses attachments as the structured image field', () => {
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
            },
        });
        expect(JSON.stringify(meta)).not.toContain('imageInputs');
    });
});
