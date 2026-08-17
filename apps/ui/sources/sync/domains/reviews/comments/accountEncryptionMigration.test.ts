import { describe, expect, it } from 'vitest';

import {
    bindReviewCommentEventSensitiveEnvelopeV1,
    buildReviewCommentEventRequestBindingV1,
    openReviewCommentEventSensitiveEnvelopeV1,
    openReviewCommentSensitiveEnvelopeV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentSensitiveEnvelopeV1,
    splitReviewCommentV1,
    type AccountScopedCryptoMaterial,
    type ReviewCommentEventV1,
    type ReviewCommentV1,
} from '@happier-dev/protocol';

import {
    buildReviewCommentAccountEncryptionMigrationDirective,
} from './accountEncryptionMigration';

const SOURCE_MATERIAL: AccountScopedCryptoMaterial = {
    type: 'dataKey',
    machineKey: new Uint8Array(32).fill(7),
};

const TARGET_MATERIAL: AccountScopedCryptoMaterial = {
    type: 'dataKey',
    machineKey: new Uint8Array(32).fill(8),
};

function comment(): ReviewCommentV1 {
    return {
        v: 1,
        id: 'comment-1',
        accountId: 'account-1',
        projectId: 'project-1',
        anchor: { kind: 'file', filePath: 'src/private.ts' },
        snapshot: {
            kind: 'text',
            selectedLines: ['private source'],
            beforeContext: [],
            afterContext: [],
            selectedLinesHash: 'selected',
            contextWindowHash: 'context',
            capturedAt: 1,
            fileLength: 1,
            source: 'workingTree',
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        },
        body: 'private body',
        bodyVersion: 1,
        edits: [],
        author: { kind: 'user', userId: 'user-1' },
        state: 'open',
        flags: {},
        dispositions: {},
        threadId: 'comment-1',
        transitions: [],
        createdAt: 1,
        updatedAt: 1,
        serverRevision: 1,
    };
}

function event(): ReviewCommentEventV1 {
    return {
        eventId: 'event-1',
        commentId: 'comment-1',
        accountId: 'account-1',
        projectId: 'project-1',
        eventKind: 'created',
        actor: { kind: 'user', userId: 'user-1' },
        createdAt: 1,
        serverRevision: 1,
        event: {
            clientMutationId: 'mutation-1',
            reason: 'private event',
        },
    };
}

function eventRequestBinding() {
    const source = event();
    return buildReviewCommentEventRequestBindingV1({
        accountId: source.accountId,
        projectId: source.projectId,
        actor: source.actor,
        actionId: 'reviews.comments.create',
        input: {
            projectId: source.projectId,
            clientMutationId: 'mutation-1',
        },
    });
}

describe('Review Comment Account-encryption UI adapter', () => {
    it('opens a strict legacy split inventory and emits one canonical E2EE target', async () => {
        const source = comment();
        const split = splitReviewCommentV1(source);
        const sourceEvent = event();
        const directive = await buildReviewCommentAccountEncryptionMigrationDirective({
            toMode: 'e2ee',
            inventory: {
                v: 1,
                items: [{
                    structural: split.structural,
                    sensitiveSource: {
                        v: 1,
                        layout: 'legacy_split_v1',
                        sourceMode: 'plain',
                        anchor: source.anchor,
                        snapshotEnvelope: { t: 'plain', v: source.snapshot },
                        bodyEnvelope: { t: 'plain', v: source.body },
                        edits: source.edits,
                        transitions: source.transitions,
                    },
                    events: [{
                        event: { ...sourceEvent, event: { clientMutationId: 'mutation-1' } },
                        sensitiveEnvelope: {
                            v: 1,
                            binding: {
                                v: 1,
                                eventId: sourceEvent.eventId,
                                commentId: sourceEvent.commentId,
                                accountId: sourceEvent.accountId,
                                projectId: sourceEvent.projectId,
                                eventKind: sourceEvent.eventKind,
                                actor: sourceEvent.actor,
                                createdAt: sourceEvent.createdAt,
                                serverRevision: sourceEvent.serverRevision,
                                clientMutationId: 'mutation-1',
                                requestBinding: eventRequestBinding(),
                            },
                            sensitive: { t: 'plain', v: sourceEvent.event },
                        },
                        sourceLayout: 'legacy_split_v1',
                    }],
                }],
            },
            targetMaterial: TARGET_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(11),
        });

        expect(directive.action).toBe('migrate');
        if (directive.action !== 'migrate') throw new Error('expected migration');
        const item = directive.items[0]!;
        expect(item.expectedSensitiveSource.layout).toBe('legacy_split_v1');
        expect(openReviewCommentSensitiveEnvelopeV1({
            structural: split.structural,
            envelope: item.targetSensitiveEnvelope,
            mode: 'e2ee',
            material: TARGET_MATERIAL,
        })).toEqual({ status: 'available', comment: source });
        expect(openReviewCommentEventSensitiveEnvelopeV1({
            event: { ...sourceEvent, event: { clientMutationId: 'mutation-1' } },
            bound: item.events[0]!.targetSensitiveEnvelope,
            mode: 'e2ee',
            material: TARGET_MATERIAL,
        })).toEqual({ status: 'available', event: sourceEvent });
    });

    it('fails closed when legacy ciphertext cannot be opened', async () => {
        const source = comment();
        const split = splitReviewCommentV1(source);
        await expect(buildReviewCommentAccountEncryptionMigrationDirective({
            toMode: 'plain',
            inventory: {
                v: 1,
                items: [{
                    structural: split.structural,
                    sensitiveSource: {
                        v: 1,
                        layout: 'legacy_split_v1',
                        sourceMode: 'e2ee',
                        anchor: source.anchor,
                        snapshotEnvelope: { t: 'encrypted', c: 'snapshot' },
                        bodyEnvelope: { t: 'encrypted', c: 'body' },
                        edits: [],
                        transitions: [],
                    },
                    events: [],
                }],
            },
            sourceMaterial: SOURCE_MATERIAL,
            openLegacyCiphertext: async () => null,
            randomBytes: (length) => new Uint8Array(length),
        })).rejects.toThrow('review_comment_migration_source_locked');
    });

    it('opens canonical E2EE comment/event content and emits one plain target', async () => {
        const source = comment();
        const split = splitReviewCommentV1(source);
        const sourceEvent = event();
        const commentEnvelope = sealReviewCommentSensitiveEnvelopeV1({
            structural: split.structural,
            sensitive: split.sensitive,
            mode: 'e2ee',
            material: SOURCE_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(12),
        });
        const eventEnvelope = bindReviewCommentEventSensitiveEnvelopeV1({
            event: sourceEvent,
            requestBinding: eventRequestBinding(),
            sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
                payload: {
                    v: 1,
                    requestBinding: eventRequestBinding(),
                    details: sourceEvent.event,
                },
                mode: 'e2ee',
                material: SOURCE_MATERIAL,
                randomBytes: (length) => new Uint8Array(length).fill(13),
            }),
        });

        const directive = await buildReviewCommentAccountEncryptionMigrationDirective({
            toMode: 'plain',
            inventory: {
                v: 1,
                items: [{
                    structural: split.structural,
                    sensitiveSource: {
                        v: 1,
                        layout: 'canonical_v1',
                        envelope: commentEnvelope,
                    },
                    events: [{
                        event: sourceEvent,
                        sensitiveEnvelope: eventEnvelope,
                        sourceLayout: 'canonical_v1',
                    }],
                }],
            },
            sourceMaterial: SOURCE_MATERIAL,
            randomBytes: (length) => new Uint8Array(length),
        });

        if (directive.action !== 'migrate') throw new Error('expected migration');
        expect(openReviewCommentSensitiveEnvelopeV1({
            structural: split.structural,
            envelope: directive.items[0]!.targetSensitiveEnvelope,
            mode: 'plain',
        })).toEqual({ status: 'available', comment: source });
        expect(openReviewCommentEventSensitiveEnvelopeV1({
            event: sourceEvent,
            bound: directive.items[0]!.events[0]!.targetSensitiveEnvelope,
            mode: 'plain',
        })).toEqual({ status: 'available', event: sourceEvent });
    });

    it('returns assert_empty without requiring encryption material', async () => {
        await expect(buildReviewCommentAccountEncryptionMigrationDirective({
            toMode: 'plain',
            inventory: { v: 1, items: [] },
            randomBytes: (length) => new Uint8Array(length),
        })).resolves.toEqual({ action: 'assert_empty' });
    });
});
