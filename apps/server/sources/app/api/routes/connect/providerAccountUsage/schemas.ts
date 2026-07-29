import { z } from "zod";

import {
    ConnectedServiceIdSchema,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageRecordWriteV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    SealedConnectedServiceQuotaSnapshotV1Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";
import type { ProviderAccountUsagePayloadMode, ProviderAccountUsageStatus } from "./types";

export const ProviderAccountUsagePayloadModeSchema = z.enum([
    "plain_json_v1",
    "sealed_account_scoped_v1",
]) satisfies z.ZodType<ProviderAccountUsagePayloadMode>;

export const ProviderAccountUsageStatusSchema = z.enum([
    "ok",
    "unavailable",
    "estimated",
    "error",
    "refresh_requested",
]) satisfies z.ZodType<ProviderAccountUsageStatus>;

export const ProviderAccountUsageRecordMetadataSchema = z.object({
    materialFingerprint: z.string().trim().min(1).max(256).optional(),
    legacyQuotaCompatibilityProjections: z.array(z.object({
        source: z.object({
            serviceId: ConnectedServiceIdSchema,
            profileId: z.string().min(1).max(128),
            bindingKind: z.literal("profile"),
        }).strict(),
        providerAccountUsageFetchedAt:
            z.number().int().nonnegative(),
        sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
    }).strict()).max(100).optional(),
}).strict();

export const UpsertProviderAccountUsageRecordSchema = z.object({
    accountId: z.string().trim().min(1),
    recordId: ProviderAccountUsageRecordIdSchema,
    recordKey: ProviderAccountUsageRecordKeyV1Schema,
    payloadMode: ProviderAccountUsagePayloadModeSchema,
    status: ProviderAccountUsageStatusSchema,
    snapshot: ProviderAccountUsageSnapshotV1Schema.optional(),
    sealedPayload: SealedProviderAccountUsageSnapshotV1Schema.optional(),
    fetchedAt: z.number().int().nonnegative().optional(),
    staleAfterMs: z.number().int().nonnegative().optional(),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
    metadata: ProviderAccountUsageRecordMetadataSchema.optional(),
}).strict();

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
        reason: ProviderAccountUsageInvalidParamsReasonSchema.optional(),
    }),
    z.object({
        statusCode: z.literal(400),
        error: z.string().min(1),
        message: z.string().min(1),
    }).passthrough(),
]);

export const ProviderAccountUsageSourceLinkOutcomeResponseSchema = z.union([
    z.object({ status: z.literal("linked") }).strict(),
    z.object({
        status: z.literal("skipped"),
        reason: z.enum(["binding_unavailable", "ownership_unproven"]),
    }).strict(),
]);

export const ProviderAccountUsageWriteSuccessResponseSchema = z.object({
    success: z.literal(true),
    source: ProviderAccountUsageSourceLinkOutcomeResponseSchema.optional(),
}).strict();

export const UpsertConnectedServiceUsageSourceSchema = z.object({
    accountId: z.string().trim().min(1),
    providerAccountUsageRecordId: ProviderAccountUsageRecordIdSchema,
}).strict().and(ConnectedServiceUsageSourceV1Schema);

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
        ...(metadata ? { metadata } : {}),
    };
}
