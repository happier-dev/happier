import { describe, expect, it } from 'vitest';

import { sanitizeSessionUserMessageSendMeta } from '@happier-dev/protocol';
import {
    type ComposerAttachmentDraftV1,
    MENTION_KIND_V1,
    buildComposerReferenceMentionPayloadV1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import {
    buildStructuredInputMetaOverrides,
    createStructuredInputMentionFromSuggestion,
    mergeMessageMetaOverrides,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
    type ComposerStructuredInputMentionPayload,
} from './structuredInputMentions';

const vendorPluginMention = {
    kind: 'vendorPlugin',
    tokenText: '@gmail',
    vendorPluginRef: 'plugin://gmail@openai-curated',
    label: 'Gmail',
} satisfies ComposerStructuredInputMention;

const skillMention = {
    kind: 'skill',
    tokenText: '$review',
    id: 'vendor:codex:codex-native:review',
    name: 'review',
    path: '/skills/review/SKILL.md',
    displayName: 'Review',
    origin: 'vendor',
    projectionRef: 'codex-native:review',
    backendId: 'codex',
    agentId: 'codex-agent',
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
        const composerText = '\nask @gmail about it';
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
        // Reconciliation runs while the user types, but the composer can send text the
        // mention list has not caught up with. The builder re-checks each token against
        // the submitted text, per mention: the edited one is dropped, its sibling stays.
        const meta = buildStructuredInputMetaOverrides({
            mentions: [
                vendorPluginMention,
                skillMention,
            ],
            text: 'Call @gmai $review',
        });

        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: MENTION_KIND_V1.skill,
                    ref: buildMentionRefForKindV1(
                        MENTION_KIND_V1.skill,
                        'vendor:codex:codex-native:review',
                    ),
                    token: '$review',
                    label: 'Review',
                }],
                skillMentions: [expect.objectContaining({ name: 'review' })],
            },
        });
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

    it('dual-writes opaque references while retaining legacy provider context for older readers', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [vendorPluginMention, skillMention],
            text: 'Call @gmail $review',
        });

        expect(meta).toMatchObject({
            happierStructuredInputV1: {
                mentions: [
                    {
                        kind: MENTION_KIND_V1.vendorPlugin,
                        ref: buildMentionRefForKindV1(
                            MENTION_KIND_V1.vendorPlugin,
                            'plugin://gmail@openai-curated',
                        ),
                        token: '@gmail',
                        label: 'Gmail',
                    },
                    {
                        kind: MENTION_KIND_V1.skill,
                        ref: buildMentionRefForKindV1(
                            MENTION_KIND_V1.skill,
                            'vendor:codex:codex-native:review',
                        ),
                        token: '$review',
                        label: 'Review',
                    },
                ],
                // The open list is for current readers; these remain until the
                // supported legacy reader window closes.
                vendorPluginMentions: [expect.objectContaining({ vendorPluginRef: 'plugin://gmail@openai-curated' })],
                skillMentions: [expect.objectContaining({ name: 'review' })],
            },
        });
    });

    it('falls back to legacy arrays when one selected mention has no canonical reference', () => {
        const legacySkill = {
            kind: 'skill',
            tokenText: '$review',
            name: 'review',
        } satisfies ComposerStructuredInputMention;

        expect(buildStructuredInputMetaOverrides({
            mentions: [vendorPluginMention, legacySkill],
            text: 'Call @gmail $review',
        })).toEqual({
            happierStructuredInputV1: {
                v: 1,
                vendorPluginMentions: [{
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    label: 'Gmail',
                }],
                skillMentions: [{ name: 'review' }],
            },
        });
    });

    it('canonicalizes skill mention origins when writing structured input metadata', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [
                {
                    kind: 'skill',
                    tokenText: '$review',
                    name: 'review',
                    origin: 'codex_native',
                },
                {
                    kind: 'skill',
                    tokenText: '$summarize',
                    name: 'summarize',
                    origin: 'happier_projected',
                },
                {
                    kind: 'skill',
                    tokenText: '$plan',
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
        expect(buildStructuredInputMetaOverrides({
            mentions: [{
                kind: 'happier.session',
                tokenText: '@session:abc',
            }],
            text: 'Call @session:abc',
        })).toEqual({});
    });

    it('forwards a persisted opaque unknown reference without coercing it into a legacy kind', () => {
        const meta = buildStructuredInputMetaOverrides({
            mentions: [{
                kind: 'partner.reference',
                ref: 'partner:thread-42',
                label: 'Thread 42',
                tokenText: '@thread-42',
            }],
            text: 'Open @thread-42',
        });

        expect(meta).toEqual({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: 'partner.reference',
                    ref: 'partner:thread-42',
                    label: 'Thread 42',
                    token: '@thread-42',
                }],
            },
        });
    });

    it('turns a selected same-server Session row into an identity-only durable reference', () => {
        const sessionId = 'cmslj08960ku1tmhrd0v4a0a7';
        const selected = createStructuredInputMentionFromSuggestion({
            suggestion: {
                kind: 'session',
                key: `session-${sessionId}`,
                text: '@session:fix-detached-dev-stack-startup-v4a0a7',
                label: 'Fix Detached Dev Stack Startup',
                structuredInput: {
                    kind: MENTION_KIND_V1.session,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, sessionId),
                    label: 'Fix Detached Dev Stack Startup',
                },
            },
        });

        expect(selected).not.toBeNull();
        expect(buildStructuredInputMetaOverrides({
            mentions: selected ? [selected] : [],
            text: 'Read @session:fix-detached-dev-stack-startup-v4a0a7',
        })).toEqual({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: MENTION_KIND_V1.session,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, sessionId),
                    label: 'Fix Detached Dev Stack Startup',
                    token: '@session:fix-detached-dev-stack-startup-v4a0a7',
                }],
            },
        });
    });

    it('preserves the canonical Composer reference identity through draft reconciliation and the canonical mention writer', () => {
        const payload: ComposerStructuredInputMentionPayload = buildComposerReferenceMentionPayloadV1({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            candidate: {
                id: 'incident-42',
                label: 'Incident 42',
                description: 'Production incident',
            },
        });
        const selected = {
            ...payload,
            tokenText: '@incident-42',
        } satisfies ComposerStructuredInputMention;
        const mentions = reconcileStructuredInputMentionsWithText({
            text: 'Read Open @incident-42',
            mentions: [selected],
        });

        expect(buildStructuredInputMetaOverrides({
            mentions,
            text: 'Read Open @incident-42',
        })).toEqual({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    ...payload,
                    token: '@incident-42',
                }],
            },
        });
    });

    it('preserves opaque references when message metadata is composed with attachments', () => {
        expect(mergeMessageMetaOverrides(
            {
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [{
                        kind: MENTION_KIND_V1.file,
                        ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/a.ts'),
                        token: '@src/a.ts',
                    }],
                },
            },
            {
                happierStructuredInputV1: {
                    v: 1,
                    imageInputs: [{ kind: 'image', url: 'https://example.test/a.png' }],
                },
            },
        )).toEqual({
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: MENTION_KIND_V1.file,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'src/a.ts'),
                    token: '@src/a.ts',
                }],
                imageInputs: [{ kind: 'image', url: 'https://example.test/a.png' }],
            },
        });
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

    it('writes persisted plugin composer attachments into the canonical structured-input envelope', () => {
        const composerAttachments: readonly ComposerAttachmentDraftV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            content: {
                kind: 'stagedMedia',
                handle: {
                    v: 1,
                    id: 'stage-42',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    owner: { pluginId: 'acme.issues', localId: 'issue' },
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    name: 'issue-42.png',
                    sizeBytes: 42,
                    sha256: 'a'.repeat(64),
                },
            },
        }];

        expect(buildStructuredInputMetaOverrides({
            composerAttachments,
        })).toEqual({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments,
            },
        });
    });

    it('retains plugin composer attachments when another metadata producer is merged', () => {
        const composerAttachments: readonly ComposerAttachmentDraftV1[] = [{
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];

        expect(mergeMessageMetaOverrides(
            buildStructuredInputMetaOverrides({ composerAttachments }),
            buildStructuredInputMetaOverrides({ attachments: [{ type: 'image', url: 'https://example.test/a.png' }] }),
        )).toEqual({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments,
                imageInputs: [{ type: 'image', url: 'https://example.test/a.png' }],
            },
        });
    });
});
