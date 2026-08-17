import {
    BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
    ReviewCommentEventV1Schema,
    openReviewCommentEventSensitiveEnvelopeV1,
    openReviewCommentSensitiveMigrationSourceV1,
    bindReviewCommentEventSensitiveEnvelopeV1,
    reviewCommentEventSensitiveBindingMatchesV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentSensitiveEnvelopeV1,
    splitReviewCommentV1,
    type AccountScopedCryptoMaterial,
    type BoundReviewCommentEventSensitiveEnvelopeV1,
    type ReviewCommentAccountEncryptionMigrationInventoryResponseV1,
    type ReviewCommentSensitiveMigrationSourceV1,
    type StoredJsonContentEnvelope,
} from '@happier-dev/protocol';

export type ReviewCommentAccountEncryptionMigrationDirectiveInputV1 =
    | Readonly<{ action: 'assert_empty' }>
    | Readonly<{
        action: 'migrate';
        items: readonly Readonly<{
            commentId: string;
            expectedServerRevision: number;
            expectedBodyVersion: number;
            expectedSensitiveSource: ReviewCommentSensitiveMigrationSourceV1;
            targetSensitiveEnvelope: StoredJsonContentEnvelope;
            events: readonly Readonly<{
                eventId: string;
                expectedSensitiveEnvelope:
                    BoundReviewCommentEventSensitiveEnvelopeV1;
                targetSensitiveEnvelope:
                    BoundReviewCommentEventSensitiveEnvelopeV1;
            }>[];
        }>[];
    }>;

function requireTargetMaterial(
    material: AccountScopedCryptoMaterial | undefined,
): AccountScopedCryptoMaterial {
    if (!material) {
        throw new Error('review_comment_migration_target_material_unavailable');
    }
    return material;
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('review_comment_migration_event_source_unreadable');
    }
    return value as Record<string, unknown>;
}

async function openLegacyEventDetails(params: Readonly<{
    event: ReviewCommentAccountEncryptionMigrationInventoryResponseV1[
        'items'
    ][number]['events'][number]['event'];
    sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
    openLegacyCiphertext?: (ciphertext: string) => Promise<unknown | null>;
}>): Promise<Record<string, unknown>> {
    if (!reviewCommentEventSensitiveBindingMatchesV1({
        event: params.event,
        bound: params.sensitiveEnvelope,
    })) {
        throw new Error('review_comment_migration_event_binding_mismatch');
    }
    const sensitive = params.sensitiveEnvelope.sensitive;
    const raw = sensitive.t === 'plain'
        ? sensitive.v
        : params.openLegacyCiphertext
            ? await params.openLegacyCiphertext(sensitive.c)
            : null;
    if (raw === null) {
        throw new Error('review_comment_migration_event_source_locked');
    }
    const details = requireRecord(raw);
    const reconstructed = ReviewCommentEventV1Schema.parse({
        ...params.event,
        event: details,
    });
    if (!reviewCommentEventSensitiveBindingMatchesV1({
        event: reconstructed,
        bound: params.sensitiveEnvelope,
    })) {
        throw new Error('review_comment_migration_event_binding_mismatch');
    }
    return details;
}

async function openEventDetails(params: Readonly<{
    item: ReviewCommentAccountEncryptionMigrationInventoryResponseV1[
        'items'
    ][number]['events'][number];
    sourceMaterial?: AccountScopedCryptoMaterial;
    openLegacyCiphertext?: (ciphertext: string) => Promise<unknown | null>;
}>): Promise<Readonly<{
    details: Record<string, unknown>;
    requestBinding: BoundReviewCommentEventSensitiveEnvelopeV1['binding']['requestBinding'];
}>> {
    const bound = BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse(
        params.item.sensitiveEnvelope,
    );
    if (params.item.sourceLayout === 'legacy_split_v1') {
        return {
            details: await openLegacyEventDetails({
            event: params.item.event,
            sensitiveEnvelope: bound,
            openLegacyCiphertext: params.openLegacyCiphertext,
            }),
            requestBinding: bound.binding.requestBinding,
        };
    }
    const opened = openReviewCommentEventSensitiveEnvelopeV1({
        event: params.item.event,
        bound,
        mode: bound.sensitive.t === 'encrypted' ? 'e2ee' : 'plain',
        material: params.sourceMaterial,
    });
    if (opened.status !== 'available') {
        throw new Error('review_comment_migration_event_source_locked');
    }
    return {
        details: opened.event.event,
        requestBinding: bound.binding.requestBinding,
    };
}

export async function buildReviewCommentAccountEncryptionMigrationDirective(
    params: Readonly<{
        toMode: 'plain' | 'e2ee';
        inventory: ReviewCommentAccountEncryptionMigrationInventoryResponseV1;
        sourceMaterial?: AccountScopedCryptoMaterial;
        targetMaterial?: AccountScopedCryptoMaterial;
        openLegacyCiphertext?: (ciphertext: string) => Promise<unknown | null>;
        randomBytes: (length: number) => Uint8Array;
    }>,
): Promise<ReviewCommentAccountEncryptionMigrationDirectiveInputV1> {
    const inventory =
        ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema.parse(
            params.inventory,
        );
    if (inventory.items.length === 0) {
        return { action: 'assert_empty' };
    }
    const targetMaterial = params.toMode === 'e2ee'
        ? requireTargetMaterial(params.targetMaterial)
        : null;
    const items = [];
    for (const item of inventory.items) {
        const opened = await openReviewCommentSensitiveMigrationSourceV1({
            structural: item.structural,
            source: item.sensitiveSource,
            material: params.sourceMaterial,
            openLegacyCiphertext: params.openLegacyCiphertext,
        });
        if (opened.status !== 'available') {
            throw new Error('review_comment_migration_source_locked');
        }
        const sensitive = splitReviewCommentV1(opened.comment).sensitive;
        const targetSensitiveEnvelope = params.toMode === 'plain'
            ? sealReviewCommentSensitiveEnvelopeV1({
                structural: item.structural,
                sensitive,
                mode: 'plain',
            })
            : sealReviewCommentSensitiveEnvelopeV1({
                structural: item.structural,
                sensitive,
                mode: 'e2ee',
                material: targetMaterial!,
                randomBytes: params.randomBytes,
            });
        const events = [];
        for (const sourceEvent of item.events) {
            const openedEvent = await openEventDetails({
                item: sourceEvent,
                sourceMaterial: params.sourceMaterial,
                openLegacyCiphertext: params.openLegacyCiphertext,
            });
            const sensitive = params.toMode === 'plain'
                ? sealReviewCommentEventSensitiveEnvelopeV1({
                    payload: {
                        v: 1,
                        requestBinding: openedEvent.requestBinding,
                        details: openedEvent.details,
                    },
                    mode: 'plain',
                })
                : sealReviewCommentEventSensitiveEnvelopeV1({
                    payload: {
                        v: 1,
                        requestBinding: openedEvent.requestBinding,
                        details: openedEvent.details,
                    },
                    mode: 'e2ee',
                    material: targetMaterial!,
                    randomBytes: params.randomBytes,
                });
            events.push({
                eventId: sourceEvent.event.eventId,
                expectedSensitiveEnvelope: sourceEvent.sensitiveEnvelope,
                targetSensitiveEnvelope:
                    bindReviewCommentEventSensitiveEnvelopeV1({
                        event: sourceEvent.event,
                        requestBinding: openedEvent.requestBinding,
                        sensitive,
                    }),
            });
        }
        items.push({
            commentId: item.structural.id,
            expectedServerRevision: item.structural.serverRevision,
            expectedBodyVersion: item.structural.bodyVersion,
            expectedSensitiveSource: item.sensitiveSource,
            targetSensitiveEnvelope,
            events,
        });
    }
    return { action: 'migrate', items };
}
