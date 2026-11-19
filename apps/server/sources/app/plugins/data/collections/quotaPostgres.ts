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
 * Start from PostgreSQL's jsonb text byte count. In its output, each object
 * member adds a space after its colon and each comma adds one space. Count
 * those separators from the containers so string bodies need no tokenization.
 * Restore JSON.stringify's fixed/exponential thresholds for admitted finite
 * JavaScript numbers without a float8 round trip (PostgreSQL's shortest-float
 * spelling differs from ECMAScript's).
 * Projection values are stored as JSON strings, so staged numeric projections
 * additionally undo jsonb's expanded spelling inside those quoted strings.
 * quota.ts's JavaScript measurement remains the reference metric.
 */
export async function readPluginCollectionPostgresQuotaAggregateInTx(input: Readonly<{
    tx: Pick<Tx, "$queryRawUnsafe">;
    accountId: string;
    includeStages: boolean;
}>): Promise<readonly PluginCollectionPostgresQuotaAggregate[]> {
    return await input.tx.$queryRawUnsafe<PluginCollectionPostgresQuotaAggregate[]>(`
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
            SELECT octet_length("quotaRows"."payload"::text) - sum("spaces") + COALESCE(sum(
                CASE WHEN "significant" = '' THEN 1 ELSE
                    (left("numericText", 1) = '-')::integer + CASE
                        WHEN "exponent" < -6 OR "exponent" >= 21 THEN
                            length("significant") + (length("significant") > 1)::integer
                            + 2 + length(abs("exponent")::text)
                        WHEN "exponent" < 0 THEN 1 - "exponent" + length("significant")
                        ELSE greatest("exponent" + 1, length("significant"))
                            + (length("significant") > "exponent" + 1)::integer
                    END
                END - octet_length("numericText")
            ), 0) AS "encodedBytes"
            FROM (
                SELECT CASE WHEN jsonb_typeof("value") = 'number' THEN "value"::text END AS "numericText",
                    CASE jsonb_typeof("value")
                        WHEN 'array' THEN greatest(jsonb_array_length("value") - 1, 0)
                        WHEN 'object' THEN greatest(
                            2 * jsonb_array_length(jsonb_path_query_array("value", 'strict $.keyvalue().key')) - 1, 0)
                        ELSE 0
                    END AS "spaces"
                FROM jsonb_array_elements(jsonb_path_query_array("quotaRows"."payload",
                    'strict $.** ? (@.type() == "object" || @.type() == "array" || @.type() == "number")')) AS "value"
                UNION ALL
                SELECT "numericText", 0
                FROM jsonb_array_elements_text("quotaRows"."numericProjections") AS "numericText"
            ) AS "adjustments"
            CROSS JOIN LATERAL (SELECT ltrim("numericText", '-') AS "absolute") AS "unsigned"
            CROSS JOIN LATERAL (SELECT replace("absolute", '.', '') AS "digits") AS "decimal"
            CROSS JOIN LATERAL (SELECT btrim("digits", '0') AS "significant",
                length(split_part("absolute", '.', 1)) - length("digits") + length(ltrim("digits", '0')) - 1 AS "exponent"
            ) AS "number"
        ) AS "measured"
        GROUP BY "quotaRows"."pluginId", "quotaRows"."collectionId", "quotaRows"."contractId", "quotaRows"."staged"
    `, input.accountId, input.includeStages);
}
