import { z } from "zod/mini";

import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema, ConnectedServiceUsageSourceV1Schema, SealedConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageRecordKeyV1Schema, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { ProviderAccountUsageRecordWriteV1Schema, SealedProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/accountUsage';
import { ProviderAccountSubscriptionV1Schema } from '@happier-dev/protocol/connect/accountSubscription';
import { ProviderAccountUsagePageProjectionMetadataV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { ProviderAccountUsageDaySummaryWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import type { ProviderAccountUsagePayloadMode, ProviderAccountUsageStatus } from "./types";

export const ProviderAccountUsagePayloadModeSchema = z.enum([
    "plain_json_v1",
    "sealed_account_scoped_v1",
]) satisfies z.ZodMiniType<ProviderAccountUsagePayloadMode>;

export const ProviderAccountUsageStatusSchema = z.enum([
    "ok",
    "unavailable",
    "estimated",
    "error",
    "refresh_requested",
]) satisfies z.ZodMiniType<ProviderAccountUsageStatus>;

export const ProviderAccountUsageRecordMetadataSchema = z.strictObject({
    daySummaryPendingDays: z.optional(z.array(ProviderAccountUsageDaySummaryWriteV1Schema.shape.dayStartAtMs)),
    pageProjection: ProviderAccountUsagePageProjectionMetadataV1Schema,
    materialFingerprint: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    subscription: z.optional(ProviderAccountSubscriptionV1Schema),
    recoveryCreditDetails: z.optional(ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema),
    legacyQuotaCompatibilityProjections: z.optional(z.array(z.strictObject({
        source: z.strictObject({
            serviceId: ConnectedServiceIdSchema,
            profileId: z.string().check(z.minLength(1), z.maxLength(128)),
            bindingKind: z.literal("profile"),
        }),
        providerAccountUsageFetchedAt:
            z.number().check(z.int(), z.nonnegative()),
        sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
    }))),
});

export const UpsertProviderAccountUsageRecordSchema = z.strictObject({
    accountId: z.string().check(z.trim(), z.minLength(1)),
    recordId: ProviderAccountUsageRecordIdSchema,
    recordKey: ProviderAccountUsageRecordKeyV1Schema,
    payloadMode: ProviderAccountUsagePayloadModeSchema,
    status: ProviderAccountUsageStatusSchema,
    snapshot: z.optional(ProviderAccountUsageSnapshotV1Schema),
    sealedPayload: z.optional(SealedProviderAccountUsageSnapshotV1Schema),
    fetchedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    staleAfterMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    metadata: z.optional(ProviderAccountUsageRecordMetadataSchema),
});

export const ProviderAccountUsageInvalidParamsReasonSchema = z.enum([
    "provider_account_usage_e2ee_required",
    "provider_account_usage_plaintext_required",
    "provider_account_usage_legacy_aliases_rejected",
    "provider_account_usage_record_id_mismatch",
    "provider_account_usage_payload_invalid",
    "connected_service_usage_source_incompatible",
    "connected_service_usage_source_invalid",
]);

export type ProviderAccountUsageInvalidParamsReason =
    z.infer<typeof ProviderAccountUsageInvalidParamsReasonSchema>;

export const ProviderAccountUsageInvalidParamsResponseSchema = z.union([
    z.object({
        error: z.literal("invalid-params"),
        reason: z.optional(ProviderAccountUsageInvalidParamsReasonSchema),
    }),
    z.looseObject({
        statusCode: z.literal(400),
        error: z.string().check(z.minLength(1)),
        message: z.string().check(z.minLength(1)),
    }),
]);

export const ProviderAccountUsageSourceLinkOutcomeResponseSchema = z.union([
    z.strictObject({ status: z.literal("linked") }),
    z.strictObject({
        status: z.literal("skipped"),
        reason: z.enum(["binding_unavailable", "ownership_unproven"]),
    }),
]);

export const ProviderAccountUsageWriteSuccessResponseSchema = z.strictObject({
    success: z.literal(true),
    source: z.optional(ProviderAccountUsageSourceLinkOutcomeResponseSchema),
});

export const UpsertConnectedServiceUsageSourceSchema = z.intersection(z.strictObject({
    accountId: z.string().check(z.trim(), z.minLength(1)),
    providerAccountUsageRecordId: ProviderAccountUsageRecordIdSchema,
}), ConnectedServiceUsageSourceV1Schema);

export function validateProviderAccountUsageRecordWrite(raw: unknown) {
    const parsed = UpsertProviderAccountUsageRecordSchema.parse(raw);
    const { accountId, metadata, ...recordWrite } = parsed;
    const canonicalRecordWrite =
        ProviderAccountUsageRecordWriteV1Schema.parse({
            ...recordWrite,
            ...(metadata?.materialFingerprint
                ? {
                    metadata: {
                        materialFingerprint:
                            metadata.materialFingerprint,
                    },
                }
                : {}),
        });
    return {
        accountId,
        ...canonicalRecordWrite,
        metadata,
    };
}
