import type { Tx } from "@/storage/inTx";

export interface PluginCollectionPostgresQuotaAggregate {
    pluginId: string;
    collectionId: string;
    contractId: string;
    staged: boolean;
    rows: bigint;
    encodedBytes: bigint;
    maximumRowEncodedBytes: bigint;
}

/**
 * PostgreSQL's jsonb text adds formatting whitespace and expands exponents.
 * Token lengths discard only whitespace outside strings. First-party content
 * writers admit JavaScript JSON values and stringify them before storage;
 * numeric tokens therefore have the finite-Number decimal digits admitted by
 * that storage boundary. Restore JSON.stringify's fixed/exponential thresholds without a
 * float8 round trip (PostgreSQL's shortest-float spelling is not ECMAScript's).
 * Projection values are stored as JSON strings, so staged numeric projections
 * additionally undo jsonb's expanded spelling inside those quoted strings.
 * quota.ts's JavaScript measurement remains the reference metric.
 */
export async function readPluginCollectionPostgresQuotaAggregateInTx(input: Readonly<{
    tx: Pick<Tx, "$queryRawUnsafe">;
    accountId: string;
    includeStages: boolean;
}>): Promise<readonly PluginCollectionPostgresQuotaAggregate[]> {
    return await input.tx.$queryRawUnsafe<PluginCollectionPostgresQuotaAggregate[]>(String.raw`
        WITH "quotaRows" AS (
            SELECT "row"."pluginId", "row"."collectionId", "row"."contractId", false AS "staged",
                jsonb_build_object(
                    'rowId', "row"."rowId", 'contentEnvelope', "row"."contentEnvelope",
                    'projections', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('fieldId', "projection"."fieldId",
                            'typedEncodedValue', "projection"."typedEncodedValue"))
                        FROM "PluginCollectionProjection" AS "projection"
                        WHERE "projection"."rowDbId" = "row"."id"
                    ), '[]'::jsonb)
                ) AS "payload", '[]'::jsonb AS "numericProjections"
            FROM "PluginCollectionRow" AS "row"
            WHERE "row"."accountId" = $1 AND "row"."deletedAt" IS NULL
            UNION ALL
            SELECT "stage"."pluginId", "stage"."collectionId", "stage"."targetContractId", true,
                jsonb_build_object(
                    'rowId', "stage"."rowId", 'contentEnvelope', "stage"."targetContentEnvelope",
                    'projections', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('fieldId', "entry"."key",
                            'typedEncodedValue', "entry"."value"::text))
                        FROM jsonb_each("stage"."targetProjection") AS "entry"
                    ), '[]'::jsonb)
                ), COALESCE((
                    SELECT jsonb_agg("entry"."value"::text)
                    FROM jsonb_each("stage"."targetProjection") AS "entry"
                    WHERE jsonb_typeof("entry"."value") = 'number'
                ), '[]'::jsonb)
            FROM "PluginCollectionCandidatePreparationStage" AS "stage"
            WHERE $2 AND "stage"."accountId" = $1
        )
        SELECT "quotaRows"."pluginId", "quotaRows"."collectionId", "quotaRows"."contractId", "quotaRows"."staged",
            count(*)::bigint AS "rows", sum("measured"."encodedBytes")::bigint AS "encodedBytes",
            max("measured"."encodedBytes")::bigint AS "maximumRowEncodedBytes"
        FROM "quotaRows"
        CROSS JOIN LATERAL (
            SELECT sum(CASE WHEN "token" ~ '^-?[0-9]' THEN
                CASE WHEN "significant" = '' THEN 1 ELSE
                    (left("token", 1) = '-')::integer + CASE
                        WHEN "exponent" < -6 OR "exponent" >= 21 THEN
                            length("significant") + (length("significant") > 1)::integer
                            + 2 + length(abs("exponent")::text)
                        WHEN "exponent" < 0 THEN 1 - "exponent" + length("significant")
                        ELSE greatest("exponent" + 1, length("significant"))
                            + (length("significant") > "exponent" + 1)::integer
                    END
                END - CASE WHEN "adjustment" THEN octet_length("token") ELSE 0 END
                ELSE octet_length("token") END) AS "encodedBytes"
            FROM (
                SELECT "match"[1] AS "token", false AS "adjustment"
                FROM regexp_matches("quotaRows"."payload"::text,
                    '"(?:[^"\\]|\\.)*"|true|false|null|-?[0-9]+(?:\.[0-9]+)?|[][{},:]', 'g') AS "match"
                UNION ALL
                SELECT "token", true FROM jsonb_array_elements_text("quotaRows"."numericProjections") AS "token"
            ) AS "tokens"
            CROSS JOIN LATERAL (SELECT ltrim("token", '-') AS "absolute") AS "unsigned"
            CROSS JOIN LATERAL (SELECT replace("absolute", '.', '') AS "digits") AS "decimal"
            CROSS JOIN LATERAL (SELECT btrim("digits", '0') AS "significant",
                length(split_part("absolute", '.', 1)) - length("digits") + length(ltrim("digits", '0')) - 1 AS "exponent"
            ) AS "number"
        ) AS "measured"
        GROUP BY "quotaRows"."pluginId", "quotaRows"."collectionId", "quotaRows"."contractId", "quotaRows"."staged"
    `, input.accountId, input.includeStages);
}
