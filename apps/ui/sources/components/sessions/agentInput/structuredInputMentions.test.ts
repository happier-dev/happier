import { describe, expect, it } from 'vitest';
import { sanitizeSessionUserMessageSendMeta } from '@happier-dev/protocol';

import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from './structuredInputMentions';

const vendorPluginMention = {
    kind: 'vendorPlugin',
    tokenText: '@gmail',
    vendorPluginRef: 'plugin://gmail@openai-curated',
    label: 'Gmail',
} satisfies ComposerStructuredInputMention;

// `origin` is what the skill catalog actually emits (`SessionSkillCatalogItemV1Schema` makes it
// required), and it is the field the canonical identity is folded from: `codex_native` becomes
// `(origin: vendor, backendId: codex)`, so the reference is `skill:vendor:codex:review`.
const skillMention = {
    kind: 'skill',
    tokenText: '$review',
    name: 'review',
    path: '/skills/review/SKILL.md',
    displayName: 'Review',
    origin: 'codex_native',
} satisfies ComposerStructuredInputMention;

describe('structured input mentions', () => {
    it.each([
        { what: 'text inserted before the token', text: 'Please Call @gmail' },
        { what: 'text inserted after the token', text: 'Call @gmail now' },
        { what: 'the whole prefix removed', text: '@gmail' },
        { what: 'a leading newline', text: '\nCall @gmail' },
    ])('keeps a selected mention through $what', ({ text }) => {
        expect(reconcileStructuredInputMentionsWithText({ text, mentions: [vendorPluginMention] }))
            .toEqual([vendorPluginMention]);
    });

    it('drops a selected mention when the token text is edited', () => {
        const mentions = reconcileStructuredInputMentionsWithText({
            text: 'Call @gmai',
            mentions: [vendorPluginMention],
        });

        expect(mentions).toEqual([]);
    });

    // The composer authors against its own text; `SessionView` submits a TRANSFORM of it
    // (`messageToSend.trim()`, and for attachments/review comments a wrapped form). A
    // reference must survive that transform: the user picked it and the token it named is
    // still in the message.
    it('survives the composer text being transformed on the way to the request boundary', () => {
        const composerText = `\nask @gmail about it`;
        const overrides = buildStructuredInputMetaOverrides({
            mentions: [vendorPluginMention],
            text: composerText,
        });
        const admitted = sanitizeSessionUserMessageSendMeta(overrides, { text: composerText.trim() });
        const envelope = admitted.happierStructuredInputV1 as { mentions?: readonly unknown[] };

        expect(envelope?.mentions).toHaveLength(1);
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
                    label: 'Gmail',
                },
                {
                    kind: 'happier.skill',
                    ref: 'skill:vendor:codex:review',
                    token: '$review',
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
                    sessionId: 'cmslj08960ku1tmhrd0v4a0a7',
                    label: 'Fix Detached Dev Stack Startup',
                }],
                text: '@session:fix-startup-v4a0a7 look at this',
            }));

            expect(envelope.mentions).toEqual([{
                kind: 'happier.session',
                ref: 'session:cmslj08960ku1tmhrd0v4a0a7',
                token: '@session:fix-startup-v4a0a7',
                label: 'Fix Detached Dev Stack Startup',
            }]);
            expect(envelope.mentions[0].ref).not.toContain('//');
            expect(envelope.mentions[0].ref).not.toContain('Fix Detached');
            // Sessions have no legacy per-kind array, so dual writing adds none.
            expect(envelope.vendorPluginMentions).toBeUndefined();
            expect(envelope.skillMentions).toBeUndefined();
        });

        it('emits exactly one reference per unique {kind, ref} (D-26)', () => {
            const envelope = readEnvelope(buildStructuredInputMetaOverrides({
                mentions: [vendorPluginMention, vendorPluginMention],
                text: '@gmail @gmail',
            }));

            // `mentions[]` is the SET of references the message carries. A second entry for the
            // same reference is byte-identical to the first now that neither carries a position.
            expect(envelope.mentions).toHaveLength(1);
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
                }],
                text: '@future:abc',
            }));

            expect(envelope.mentions).toEqual([
                { kind: 'happier.futureThing', ref: 'futureThing:abc', token: '@future:abc' },
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

    it('decides each mention independently of its siblings', () => {
        expect(reconcileStructuredInputMentionsWithText({
            text: 'Hey @gmail',
            mentions: [vendorPluginMention, skillMention],
        })).toEqual([vendorPluginMention]);
    });

    it('matches a token containing an astral code point', () => {
        // Containment compares strings, so a surrogate pair needs no special handling — but a
        // token that differs only in its emoji must still not match.
        const emojiMention = {
            ...vendorPluginMention,
            tokenText: '@"notes \u{1F600}.md"',
        } satisfies ComposerStructuredInputMention;

        expect(reconcileStructuredInputMentionsWithText({
            text: 'read @"notes \u{1F600}.md" first',
            mentions: [emojiMention],
        })).toEqual([emojiMention]);
        expect(reconcileStructuredInputMentionsWithText({
            text: 'read @"notes \u{1F601}.md" first',
            mentions: [emojiMention],
        })).toEqual([]);
    });

    it('reconciles a mention of an unknown kind through the same generic path (INV-4)', () => {
        const unknownMention = {
            kind: 'happier.session',
            tokenText: '@session:abc',
        } satisfies ComposerStructuredInputMention;

        expect(reconcileStructuredInputMentionsWithText({
            text: 'Please Call @session:abc',
            mentions: [unknownMention],
        })).toEqual([unknownMention]);

        expect(reconcileStructuredInputMentionsWithText({
            text: 'Call @session:ab',
            mentions: [unknownMention],
        })).toEqual([]);
    });

    it('never projects an unknown kind into a legacy per-kind array', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [{
                kind: 'happier.session',
                tokenText: '@session:abc',
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
