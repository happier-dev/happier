import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import {
    VoiceProviderConversationIdentityCollisionError,
    assertVoiceProviderConversationIdentityExactMatch,
    createVoiceProviderConversationIdentity,
} from "./voiceProviderConversationIdentity";

export type VoiceProviderConversationIdentityBackfillBatchResult = Readonly<{
    conversationsUpdated: number;
    leasesUpdated: number;
}>;

export type VoiceProviderConversationIdentityBackfillRemaining = Readonly<{
    conversations: number;
    leases: number;
}>;

export async function countVoiceProviderConversationIdentityBackfillRemaining(): Promise<VoiceProviderConversationIdentityBackfillRemaining> {
    const [conversations, leases] = await Promise.all([
        db.voiceConversation.count({
            where: { providerConversationKey: null },
        }),
        db.voiceSessionLease.count({
            where: {
                providerConversationKey: null,
                providerId: { not: null },
                providerConversationId: { not: null },
            },
        }),
    ]);
    return { conversations, leases };
}

/**
 * Backfills one bounded batch for rolling deployments whose migration added
 * nullable digest columns. Re-run until both counters are zero before the
 * follow-up NOT NULL/legacy-index removal migration is deployed.
 */
export async function backfillVoiceProviderConversationIdentityBatch(params: Readonly<{
    batchSize: number;
}>): Promise<VoiceProviderConversationIdentityBackfillBatchResult> {
    const batchSize = Math.max(1, Math.min(1_000, Math.floor(params.batchSize)));
    return inTx(async (tx) => {
        const [conversations, leases] = await Promise.all([
            tx.voiceConversation.findMany({
                where: { providerConversationKey: null },
                orderBy: { id: "asc" },
                take: batchSize,
                select: {
                    id: true,
                    providerId: true,
                    providerConversationId: true,
                },
            }),
            tx.voiceSessionLease.findMany({
                where: {
                    providerConversationKey: null,
                    providerId: { not: null },
                    providerConversationId: { not: null },
                },
                orderBy: { id: "asc" },
                take: batchSize,
                select: {
                    id: true,
                    accountId: true,
                    providerId: true,
                    providerConversationId: true,
                },
            }),
        ]);

        const conversationUpdates = conversations.map((row) => ({
            row,
            identity: createVoiceProviderConversationIdentity({
                providerId: row.providerId,
                providerConversationId: row.providerConversationId,
            }),
        }));
        const leaseUpdates = leases.flatMap((row) => {
            if (row.providerId === null || row.providerConversationId === null) return [];
            return [{
                row,
                identity: createVoiceProviderConversationIdentity({
                    providerId: row.providerId,
                    providerConversationId: row.providerConversationId,
                }),
            }];
        });

        // Collision/duplicate reads precede the first mutation, so a rejected batch
        // leaves every row unchanged.
        for (const entry of conversationUpdates) {
            const existing = await tx.voiceConversation.findUnique({
                where: {
                    providerId_providerConversationKey: {
                        providerId: entry.identity.providerId,
                        providerConversationKey: entry.identity.providerConversationKey,
                    },
                },
                select: {
                    id: true,
                    providerId: true,
                    providerConversationId: true,
                    providerConversationKey: true,
                },
            });
            if (!existing) continue;
            assertVoiceProviderConversationIdentityExactMatch({
                expected: entry.identity,
                stored: {
                    providerId: existing.providerId,
                    providerConversationId: existing.providerConversationId,
                    providerConversationKey: existing.providerConversationKey ?? "",
                },
            });
            if (existing.id !== entry.row.id) {
                throw new VoiceProviderConversationIdentityCollisionError();
            }
        }

        for (const entry of leaseUpdates) {
            const existingKeyRows = await tx.voiceSessionLease.findMany({
                where: {
                    accountId: entry.row.accountId,
                    providerId: entry.identity.providerId,
                    providerConversationKey: entry.identity.providerConversationKey,
                },
                select: {
                    providerId: true,
                    providerConversationId: true,
                    providerConversationKey: true,
                },
            });
            for (const existing of existingKeyRows) {
                if (existing.providerId === null || existing.providerConversationId === null) {
                    throw new VoiceProviderConversationIdentityCollisionError();
                }
                assertVoiceProviderConversationIdentityExactMatch({
                    expected: entry.identity,
                    stored: {
                        providerId: existing.providerId,
                        providerConversationId: existing.providerConversationId,
                        providerConversationKey: existing.providerConversationKey ?? "",
                    },
                });
            }
        }

        let conversationsUpdated = 0;
        for (const entry of conversationUpdates) {
            const update = await tx.voiceConversation.updateMany({
                where: {
                    id: entry.row.id,
                    providerConversationKey: null,
                    providerId: entry.identity.providerId,
                    providerConversationId: entry.identity.providerConversationId,
                },
                data: { providerConversationKey: entry.identity.providerConversationKey },
            });
            conversationsUpdated += update.count;
        }

        let leasesUpdated = 0;
        for (const entry of leaseUpdates) {
            const update = await tx.voiceSessionLease.updateMany({
                where: {
                    id: entry.row.id,
                    providerConversationKey: null,
                    providerId: entry.identity.providerId,
                    providerConversationId: entry.identity.providerConversationId,
                },
                data: { providerConversationKey: entry.identity.providerConversationKey },
            });
            leasesUpdated += update.count;
        }

        return { conversationsUpdated, leasesUpdated };
    });
}
