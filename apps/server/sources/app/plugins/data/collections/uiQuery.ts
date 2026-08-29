import {
    PluginAccountPluginIntentV1Schema,
    PluginCollectionContractReadResultV1Schema,
    PluginCollectionContractRefV1Schema,
    PluginCollectionGetResultV1Schema,
    PluginCollectionQueryResultV1Schema,
    PluginCollectionRowV1Schema,
    PluginCollectionUiQueryResultV1Schema,
    PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1,
    assertPluginCollectionContentEnvelopeForModeV1,
    comparePluginCollectionIndexSortKeysV1,
    computeCanonicalDomainSeparatedDigest,
    decodeBase64,
    encodeBase64,
    encodePluginCollectionIndexTuplePrefixV1,
    getPluginCollectionScalarKindV1,
    isCanonicalPluginCollectionIndexedInstantV1,
    nextPluginCollectionIndexPrefixV1,
    validatePluginCollectionUiQueryParametersV1,
    validatePluginCollectionUiQueryResultV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionContractReadRequestV1,
    type PluginCollectionContractReadResultV1,
    type PluginCollectionContractRefV1,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionScalarKindV1,
    type PluginCollectionIndexScalarV1,
    type PluginCollectionGetRequestV1,
    type PluginCollectionGetResultV1,
    type PluginCollectionIndexScalarValueV1,
    type PluginCollectionQueryRequestV1,
    type PluginCollectionQueryResultV1,
    type PluginCollectionReadErrorCodeV1,
    type PluginCollectionRowV1,
    type PluginCollectionUiQueryRequestV1,
    type PluginCollectionUiQueryResultV1,
} from "@happier-dev/protocol";
import { z } from "zod";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { readMaterializedPluginCollectionContract } from "./contracts";
import { readPluginCollectionIndexEntriesByRawOrdinalKey } from "./rawOrdinalIndex";

const COLLECTION_CURSOR_VERSION = 1;
const COLLECTION_CURSOR_FINGERPRINT_BYTES = 32;
const COLLECTION_CURSOR_HEADER_BYTES = 1 + COLLECTION_CURSOR_FINGERPRINT_BYTES + 2;

type QueryBounds = Readonly<{
    lower?: Uint8Array;
    upper?: Uint8Array;
    queryFingerprint: string;
    empty: boolean;
}>;

type AccountQueryCurrentness = Readonly<{
    encryptionMode: "plain" | "e2ee";
    changeCursor: number;
}>;

type CurrentCollectionQuery = Readonly<{
    account: AccountQueryCurrentness;
    contractId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>;

type CollectionPageRow = Readonly<{
    rowId: string;
    revision: number;
    contentEnvelope: unknown;
    projections: readonly Readonly<{
        fieldId: string;
        typedEncodedValue: string;
        rowRevision: number;
    }>[];
}>;

type CollectionIndexPage = Readonly<{
    pageEntries: readonly Readonly<{
        encodedSortKey: Uint8Array;
        rowId: string;
        rowRevision: number;
    }>[];
    rowsById: ReadonlyMap<string, CollectionPageRow>;
    nextCursor?: string;
}>;

/**
 * The Account, admitted contract, index and row reads that make one query
 * result must share the same database snapshot.  Keep that boundary explicit
 * so neither the direct reader nor the static UI adapter can introduce an
 * independent cursor/read path.
 */
type CollectionQueryReadClient = Pick<Tx,
    "$queryRaw"
    | "account"
    | "accountPluginIntent"
    | "pluginCollectionContract"
    | "pluginCollectionIndexState"
    | "pluginCollectionIndexEntry"
    | "pluginCollectionRow"
>;

/**
 * One canonical Collection read failure at the authenticated server boundary.
 * Static UI queries are an adapter over this owner, rather than a second
 * query/error path.
 */
export class PluginCollectionReadOperationError extends Error {
    constructor(readonly code: PluginCollectionReadErrorCodeV1) {
        super(code);
        this.name = "PluginCollectionReadOperationError";
    }
}

export class PluginCollectionUiQueryOperationError extends PluginCollectionReadOperationError {
    constructor(readonly code: PluginCollectionReadErrorCodeV1) {
        super(code);
        this.name = "PluginCollectionUiQueryOperationError";
    }
}

function parseCurrentAccount(input: Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
    seq: number;
}>): AccountQueryCurrentness {
    const currentness = deriveAccountEncryptionCurrentnessFromRow(input);
    if (currentness.status !== "ready") {
        throw new PluginCollectionUiQueryOperationError("collection_content_mode_mismatch");
    }
    return {
        encryptionMode: currentness.currentness.encryptionMode,
        changeCursor: input.seq,
    };
}

function scalarKindForContractField(
    contract: NormalizedPluginAccountCollectionContractV1,
    field: string,
): PluginCollectionScalarKindV1 {
    try {
        return getPluginCollectionScalarKindV1({ schema: contract.schema, field });
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
    }
}

function assertContentEnvelopeMode(value: unknown, encryptionMode: "plain" | "e2ee"): void {
    try {
        assertPluginCollectionContentEnvelopeForModeV1(value, encryptionMode);
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_content_mode_mismatch");
    }
}

function resolveDescriptorValue(
    value: NormalizedPluginCollectionUiQueryDescriptorV1["prefix"][number],
    parameters: PluginCollectionUiQueryRequestV1["parameters"],
): null | boolean | string | number {
    if (value.kind === "literal") return value.value;
    const parameter = parameters[value.parameterId];
    if (parameter === undefined) {
        throw new PluginCollectionUiQueryOperationError("collection_query_invalid");
    }
    return parameter;
}

function encodeQueryPrefix(input: Readonly<{
    values: readonly PluginCollectionIndexScalarV1[];
}>): Uint8Array | undefined {
    if (input.values.length === 0) return undefined;
    try {
        return encodePluginCollectionIndexTuplePrefixV1({ fields: input.values });
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
    }
}

function buildQueryBounds(input: Readonly<{
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    descriptor: NormalizedPluginCollectionUiQueryDescriptorV1;
    request: PluginCollectionUiQueryRequestV1;
}>): QueryBounds {
    const index = input.contract.indexes.find((candidate) => candidate.id === input.descriptor.indexId);
    if (!index) {
        throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
    }
    try {
        validatePluginCollectionUiQueryParametersV1(input.descriptor, input.request.parameters);
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_query_invalid");
    }

    const prefix = input.descriptor.prefix.map((value, position) => ({
        kind: scalarKindForContractField(input.contract, index.fields[position]!.field),
        value: resolveDescriptorValue(value, input.request.parameters),
        direction: index.fields[position]!.direction,
    }) satisfies PluginCollectionIndexScalarV1);
    const rangeField = index.fields[prefix.length];
    const basePrefix = encodeQueryPrefix({ values: prefix });
    const lowerValuePrefix = input.descriptor.range?.lower && rangeField
        ? encodeQueryPrefix({
            values: [...prefix, {
                kind: scalarKindForContractField(input.contract, rangeField.field),
                value: resolveDescriptorValue(input.descriptor.range.lower, input.request.parameters),
                direction: rangeField.direction,
            }],
        })
        : undefined;
    const upperValuePrefix = input.descriptor.range?.upper && rangeField
        ? encodeQueryPrefix({
            values: [...prefix, {
                kind: scalarKindForContractField(input.contract, rangeField.field),
                value: resolveDescriptorValue(input.descriptor.range.upper, input.request.parameters),
                direction: rangeField.direction,
            }],
        })
        : undefined;
    const nextPrefix = (prefixValue: Uint8Array | undefined): Uint8Array | undefined => {
        if (prefixValue === undefined) return undefined;
        try {
            return nextPluginCollectionIndexPrefixV1(prefixValue) ?? undefined;
        } catch {
            throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
        }
    };
    const descendingRange = rangeField?.direction === "desc";
    const lower = descendingRange
        ? upperValuePrefix ?? basePrefix
        : lowerValuePrefix ?? basePrefix;
    const upper = descendingRange
        ? nextPrefix(lowerValuePrefix ?? basePrefix)
        : nextPrefix(upperValuePrefix ?? basePrefix);
    if (!input.descriptor.range) {
        // An equality-only prefix always uses the one contiguous encoded tuple
        // range, regardless of the next index field's declared direction.
        const equalityUpper = nextPrefix(basePrefix);
        const queryFingerprint = computeCanonicalDomainSeparatedDigest(
            "happier.plugin.collection-ui-query.cursor.v1",
            [
                input.accountId,
                input.contract.contractDigest,
                input.descriptor.indexId,
                input.descriptor.id,
                input.descriptor.order,
                basePrefix ?? new Uint8Array(),
                equalityUpper ?? new Uint8Array(),
            ],
        );
        return {
            ...(basePrefix !== undefined ? { lower: basePrefix } : {}),
            ...(equalityUpper !== undefined ? { upper: equalityUpper } : {}),
            queryFingerprint,
            empty: basePrefix !== undefined
                && equalityUpper !== undefined
                && comparePluginCollectionIndexSortKeysV1(basePrefix, equalityUpper) >= 0,
        };
    }
    const queryFingerprint = computeCanonicalDomainSeparatedDigest(
        "happier.plugin.collection-ui-query.cursor.v1",
        [
            input.accountId,
            input.contract.contractDigest,
            input.descriptor.indexId,
            input.descriptor.id,
            input.descriptor.order,
            lower ?? new Uint8Array(),
            upper ?? new Uint8Array(),
        ],
    );
    return {
        ...(lower !== undefined ? { lower } : {}),
        ...(upper !== undefined ? { upper } : {}),
        queryFingerprint,
        empty: lower !== undefined
            && upper !== undefined
            && comparePluginCollectionIndexSortKeysV1(lower, upper) >= 0,
    };
}

function encodeCursor(input: Readonly<{
    queryFingerprint: string;
    lastSortKey: Uint8Array;
}>): string {
    const fingerprint = decodeBase64(input.queryFingerprint, "base64url");
    if (
        encodeBase64(fingerprint, "base64url") !== input.queryFingerprint
        || fingerprint.byteLength !== COLLECTION_CURSOR_FINGERPRINT_BYTES
        || input.lastSortKey.byteLength === 0
        || input.lastSortKey.byteLength > PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1
    ) {
        throw new Error("Collection cursor cannot encode an invalid canonical key.");
    }
    const cursor = new Uint8Array(COLLECTION_CURSOR_HEADER_BYTES + input.lastSortKey.byteLength);
    cursor[0] = COLLECTION_CURSOR_VERSION;
    cursor.set(fingerprint, 1);
    new DataView(cursor.buffer).setUint16(
        1 + COLLECTION_CURSOR_FINGERPRINT_BYTES,
        input.lastSortKey.byteLength,
        false,
    );
    cursor.set(input.lastSortKey, COLLECTION_CURSOR_HEADER_BYTES);
    return encodeBase64(cursor, "base64url");
}

function decodeCursor(input: Readonly<{
    cursor: string;
    queryFingerprint: string;
}>): Uint8Array {
    try {
        const bytes = decodeBase64(input.cursor, "base64url");
        if (encodeBase64(bytes, "base64url") !== input.cursor) {
            throw new Error("Cursor is not canonical base64url.");
        }
        if (bytes.byteLength < COLLECTION_CURSOR_HEADER_BYTES || bytes[0] !== COLLECTION_CURSOR_VERSION) {
            throw new Error("Cursor envelope is invalid.");
        }
        const sortKeyLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
            1 + COLLECTION_CURSOR_FINGERPRINT_BYTES,
            false,
        );
        if (
            sortKeyLength === 0
            || sortKeyLength > PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1
            || bytes.byteLength !== COLLECTION_CURSOR_HEADER_BYTES + sortKeyLength
        ) {
            throw new Error("Cursor key length is invalid.");
        }
        const fingerprint = encodeBase64(
            bytes.slice(1, 1 + COLLECTION_CURSOR_FINGERPRINT_BYTES),
            "base64url",
        );
        if (fingerprint !== input.queryFingerprint) {
            throw new Error("Cursor belongs to a different query.");
        }
        return bytes.slice(COLLECTION_CURSOR_HEADER_BYTES);
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_cursor_invalid");
    }
}

/**
 * Intersects an opaque page position with the declared index interval. A
 * cursor fingerprint binds reuse to one query, but it is not a secret, so a
 * caller-supplied descending sort key must never replace that query's upper
 * bound and expand its result set.
 */
function entryWhereForPage(input: Readonly<{
    bounds: Pick<QueryBounds, "lower" | "upper">;
    lastSortKey?: Uint8Array;
    order: "asc" | "desc";
}>): Readonly<{ lower?: Uint8Array; upper?: Uint8Array; after?: Uint8Array }> {
    if (input.order === "asc") {
        return {
            ...(input.bounds.lower !== undefined ? { lower: input.bounds.lower } : {}),
            ...(input.bounds.upper !== undefined ? { upper: input.bounds.upper } : {}),
            ...(input.lastSortKey !== undefined ? { after: input.lastSortKey } : {}),
        };
    }
    const upper = input.lastSortKey === undefined
        ? input.bounds.upper
        : input.bounds.upper === undefined
            || comparePluginCollectionIndexSortKeysV1(input.lastSortKey, input.bounds.upper) < 0
            ? input.lastSortKey
            : input.bounds.upper;
    return {
        ...(input.bounds.lower !== undefined ? { lower: input.bounds.lower } : {}),
        ...(upper !== undefined ? { upper } : {}),
    };
}

/**
 * The direct and static UI readers have distinct bounds and materialization
 * contracts, but share this one transaction-scoped index/page executor. It
 * owns readiness, opaque cursor admission, raw ordinal paging, exact row
 * revision correspondence, and continuation construction.
 */
async function readCollectionIndexPageInTx(input: Readonly<{
    tx: CollectionQueryReadClient;
    accountId: string;
    current: CurrentCollectionQuery;
    indexId: string;
    bounds: QueryBounds;
    cursor?: string;
    order: "asc" | "desc";
    limit: number;
    projectedFields?: readonly string[];
    error(code: PluginCollectionReadErrorCodeV1): PluginCollectionReadOperationError;
}>): Promise<CollectionIndexPage> {
    const indexState = await input.tx.pluginCollectionIndexState.findFirst({
        where: {
            accountId: input.accountId,
            pluginId: input.current.contract.pluginId,
            collectionId: input.current.contract.collectionId,
            indexId: input.indexId,
            contractDigest: input.current.contract.contractDigest,
            buildState: "ready",
            indexedThroughRevision: { not: null },
        },
        select: { id: true, contractId: true },
    });
    if (!indexState || indexState.contractId !== input.current.contractId) {
        throw input.error("collection_index_not_ready");
    }

    const lastSortKey = input.cursor
        ? decodeCursor({ cursor: input.cursor, queryFingerprint: input.bounds.queryFingerprint })
        : undefined;
    const entryBounds = entryWhereForPage({
        bounds: input.bounds,
        lastSortKey,
        order: input.order,
    });
    const entries = input.bounds.empty
        ? []
        : await readPluginCollectionIndexEntriesByRawOrdinalKey({
            tx: input.tx,
            indexStateId: indexState.id,
            bounds: entryBounds,
            order: input.order,
            take: input.limit + 1,
        });
    if (entries === null) {
        throw input.error("collection_contract_inconsistent");
    }
    const pageEntries = entries.slice(0, input.limit);
    const rowWhere = {
        accountId: input.accountId,
        pluginId: input.current.contract.pluginId,
        collectionId: input.current.contract.collectionId,
        schemaVersion: input.current.contract.schemaVersion,
        contractDigest: input.current.contract.contractDigest,
        deletedAt: null,
        rowId: { in: pageEntries.map((entry) => entry.rowId) },
    };
    const rows: readonly CollectionPageRow[] = pageEntries.length === 0
        ? []
        : input.projectedFields === undefined
            ? await input.tx.pluginCollectionRow.findMany({
                where: rowWhere,
                select: {
                    rowId: true,
                    revision: true,
                    contentEnvelope: true,
                    projections: {
                        select: {
                            fieldId: true,
                            typedEncodedValue: true,
                            rowRevision: true,
                        },
                    },
                },
            })
            : await input.tx.pluginCollectionRow.findMany({
                where: rowWhere,
                select: {
                    rowId: true,
                    revision: true,
                    contentEnvelope: true,
                    projections: {
                        where: { fieldId: { in: [...input.projectedFields] } },
                        select: {
                            fieldId: true,
                            typedEncodedValue: true,
                            rowRevision: true,
                        },
                    },
                },
            });
    return {
        pageEntries,
        rowsById: new Map(rows.map((row) => [row.rowId, row])),
        ...(entries.length > input.limit && pageEntries.length > 0
            ? {
                nextCursor: encodeCursor({
                    queryFingerprint: input.bounds.queryFingerprint,
                    lastSortKey: pageEntries[pageEntries.length - 1]!.encodedSortKey,
                }),
            }
            : {}),
    };
}

function projectionValue(input: Readonly<{
    encoded: string;
    kind: PluginCollectionScalarKindV1;
}>): null | boolean | string | number {
    try {
        const value: unknown = JSON.parse(input.encoded);
        if (value === null) return null;
        if (input.kind === "boolean" && typeof value === "boolean") return value;
        if (input.kind === "finiteNumber" && typeof value === "number" && Number.isFinite(value)) return value;
        if (input.kind === "string" && typeof value === "string") return value;
        if (
            input.kind === "instant"
            && typeof value === "string"
            && isCanonicalPluginCollectionIndexedInstantV1(value)
        ) return value;
    } catch {
        // The typed branch below converts every malformed projection to one
        // fail-closed contract result without leaking any field value.
    }
    throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
}

async function resolveCurrentContract(input: Readonly<{
    accountId: string;
    request: Readonly<{ pluginId: string; collectionId: string }>;
}>, database: CollectionQueryReadClient = db): Promise<CurrentCollectionQuery> {
    const account = await database.account.findUnique({
        where: { id: input.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            seq: true,
        },
    });
    if (!account) throw new PluginCollectionUiQueryOperationError("collection_unavailable");
    const currentAccount = parseCurrentAccount(account);

    const intent = await database.accountPluginIntent.findUnique({
        where: {
            accountId_pluginId: {
                accountId: input.accountId,
                pluginId: input.request.pluginId,
            },
        },
        select: {
            pluginId: true,
            desiredVersion: true,
            enabled: true,
            offlineUiHosting: true,
            writableCollections: true,
            revision: true,
        },
    });
    if (!intent) throw new PluginCollectionUiQueryOperationError("collection_unavailable");
    const parsedIntent = PluginAccountPluginIntentV1Schema.safeParse({
        pluginId: intent.pluginId,
        desiredVersion: intent.desiredVersion,
        enabled: intent.enabled,
        offlineUiHosting: intent.offlineUiHosting,
        writableCollections: intent.writableCollections,
        revision: intent.revision.toString(),
    });
    if (!parsedIntent.success || !parsedIntent.data.enabled || parsedIntent.data.desiredVersion === null) {
        throw new PluginCollectionUiQueryOperationError("collection_unavailable");
    }
    const writer = parsedIntent.data.writableCollections.find((candidate) => (
        candidate.collectionId === input.request.collectionId
    ));
    if (!writer) throw new PluginCollectionUiQueryOperationError("collection_unavailable");

    const persisted = await database.pluginCollectionContract.findFirst({
        where: {
            pluginId: writer.pluginId,
            collectionId: writer.collectionId,
            schemaVersion: writer.schemaVersion,
            contractDigest: writer.contractDigest,
        },
        select: {
            id: true,
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
            normalizedSchema: true,
            indexes: true,
            relations: true,
            privacyProjection: true,
        },
    });
    if (!persisted) throw new PluginCollectionUiQueryOperationError("collection_unavailable");
    try {
        return {
            account: currentAccount,
            contractId: persisted.id,
            contract: readMaterializedPluginCollectionContract(persisted),
        };
    } catch {
        throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
    }
}

function refsMatch(
    left: PluginCollectionContractRefV1,
    right: PluginCollectionContractRefV1,
): boolean {
    return left.pluginId === right.pluginId
        && left.collectionId === right.collectionId
        && left.schemaVersion === right.schemaVersion
        && left.contractDigest === right.contractDigest;
}

/**
 * Data's exact-ref projection for an already admitted Account release. The
 * release/intent rows grant the ref; immutable Data columns alone reconstruct
 * the contract. Neither a UI manifest nor a caller-supplied writer context can
 * substitute for that correspondence.
 */
export async function readCurrentPluginCollectionContract(input: Readonly<{
    accountId: string;
    request: PluginCollectionContractReadRequestV1;
}>): Promise<PluginCollectionContractReadResultV1> {
    const ref = PluginCollectionContractRefV1Schema.parse(input.request.ref);
    const account = await db.account.findUnique({
        where: { id: input.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            seq: true,
        },
    });
    if (!account) throw new PluginCollectionReadOperationError("collection_unavailable");
    const currentAccount = parseCurrentAccount(account);

    const intent = await db.accountPluginIntent.findUnique({
        where: {
            accountId_pluginId: {
                accountId: input.accountId,
                pluginId: ref.pluginId,
            },
        },
        select: {
            pluginId: true,
            desiredVersion: true,
            enabled: true,
            offlineUiHosting: true,
            writableCollections: true,
            revision: true,
        },
    });
    if (!intent) throw new PluginCollectionReadOperationError("collection_unavailable");
    const parsedIntent = PluginAccountPluginIntentV1Schema.safeParse({
        pluginId: intent.pluginId,
        desiredVersion: intent.desiredVersion,
        enabled: intent.enabled,
        offlineUiHosting: intent.offlineUiHosting,
        writableCollections: intent.writableCollections,
        revision: intent.revision.toString(),
    });
    if (!parsedIntent.success || !parsedIntent.data.enabled || parsedIntent.data.desiredVersion === null) {
        throw new PluginCollectionReadOperationError("collection_unavailable");
    }
    const writableRef = parsedIntent.data.writableCollections.find((candidate) => (
        candidate.collectionId === ref.collectionId
    ));
    if (!writableRef || !refsMatch(writableRef, ref)) {
        throw new PluginCollectionReadOperationError("collection_unavailable");
    }

    const release = await db.accountPluginRelease.findUnique({
        where: {
            accountId_pluginId_version: {
                accountId: input.accountId,
                pluginId: ref.pluginId,
                version: parsedIntent.data.desiredVersion,
            },
        },
        select: {
            pluginId: true,
            version: true,
            collectionContracts: true,
        },
    });
    if (
        !release
        || release.pluginId !== ref.pluginId
        || release.version !== parsedIntent.data.desiredVersion
    ) {
        throw new PluginCollectionReadOperationError("collection_unavailable");
    }
    const releaseContracts = z.array(PluginCollectionContractRefV1Schema)
        .safeParse(release.collectionContracts);
    if (!releaseContracts.success) {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
    const releaseRef = releaseContracts.data.filter((candidate) => (
        candidate.collectionId === ref.collectionId
    ));
    if (releaseRef.length !== 1 || !refsMatch(releaseRef[0]!, ref)) {
        throw new PluginCollectionReadOperationError("collection_unavailable");
    }

    const persisted = await db.pluginCollectionContract.findFirst({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
        select: {
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
            normalizedSchema: true,
            indexes: true,
            relations: true,
            privacyProjection: true,
        },
    });
    if (!persisted) throw new PluginCollectionReadOperationError("collection_unavailable");
    let contract: NormalizedPluginAccountCollectionContractV1;
    try {
        contract = readMaterializedPluginCollectionContract(persisted);
    } catch {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
    if (!refsMatch(contract, ref)) {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
    await readCurrentAccountChangeCursor({
        accountId: input.accountId,
        expectedMode: currentAccount.encryptionMode,
    });
    return PluginCollectionContractReadResultV1Schema.parse({ contract });
}

async function readCurrentAccountChangeCursor(input: Readonly<{
    accountId: string;
    expectedMode: "plain" | "e2ee";
}>, database: Pick<Tx, "account"> = db): Promise<number> {
    const account = await database.account.findUnique({
        where: { id: input.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            seq: true,
        },
    });
    if (!account) throw new PluginCollectionUiQueryOperationError("collection_unavailable");
    const current = parseCurrentAccount(account);
    if (current.encryptionMode !== input.expectedMode) {
        throw new PluginCollectionUiQueryOperationError("collection_content_mode_mismatch");
    }
    return current.changeCursor;
}

function directIndexScalar(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    field: string;
    direction: "asc" | "desc";
    value: PluginCollectionIndexScalarValueV1;
}>): PluginCollectionIndexScalarV1 {
    return {
        kind: scalarKindForContractField(input.contract, input.field),
        value: input.value,
        direction: input.direction,
    };
}

function encodeDirectQueryPrefix(input: Readonly<{
    fields: readonly PluginCollectionIndexScalarV1[];
}>): Uint8Array | undefined {
    if (input.fields.length === 0) return undefined;
    try {
        return encodePluginCollectionIndexTuplePrefixV1(input);
    } catch {
        throw new PluginCollectionReadOperationError("collection_query_invalid");
    }
}

function nextDirectQueryPrefix(value: Uint8Array | undefined): Uint8Array | undefined {
    if (value === undefined) return undefined;
    try {
        return nextPluginCollectionIndexPrefixV1(value) ?? undefined;
    } catch {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
}

/**
 * Converts the only admitted generic index predicate into the same bounded
 * sort-key interval that the static UI adapter consumes. There is no
 * alternate predicate language or index-selection path.
 */
function buildDirectQueryBounds(input: Readonly<{
    accountId: string;
    contract: NormalizedPluginAccountCollectionContractV1;
    request: PluginCollectionQueryRequestV1;
}>): QueryBounds {
    const index = input.contract.indexes.find((candidate) => candidate.id === input.request.indexId);
    if (!index || input.request.prefix.length > index.fields.length) {
        throw new PluginCollectionReadOperationError("collection_query_invalid");
    }
    const prefix = input.request.prefix.map((value, position) => {
        const field = index.fields[position];
        if (!field) throw new PluginCollectionReadOperationError("collection_query_invalid");
        return directIndexScalar({
            contract: input.contract,
            field: field.field,
            direction: field.direction,
            value,
        });
    });
    const rangeField = index.fields[prefix.length];
    if (input.request.range && !rangeField) {
        throw new PluginCollectionReadOperationError("collection_query_invalid");
    }

    const basePrefix = encodeDirectQueryPrefix({ fields: prefix });
    const boundPrefix = (value: PluginCollectionIndexScalarValueV1 | undefined): Uint8Array | undefined => {
        if (value === undefined || !rangeField) return undefined;
        return encodeDirectQueryPrefix({
            fields: [...prefix, directIndexScalar({
                contract: input.contract,
                field: rangeField.field,
                direction: rangeField.direction,
                value,
            })],
        });
    };
    const lowerValuePrefix = boundPrefix(input.request.range?.lower);
    const upperValuePrefix = boundPrefix(input.request.range?.upper);
    if (!input.request.range) {
        const upper = nextDirectQueryPrefix(basePrefix);
        return {
            ...(basePrefix !== undefined ? { lower: basePrefix } : {}),
            ...(upper !== undefined ? { upper } : {}),
            queryFingerprint: computeCanonicalDomainSeparatedDigest(
                "happier.plugin.collection-query.cursor.v1",
                [
                    input.accountId,
                    input.contract.pluginId,
                    input.contract.collectionId,
                    input.contract.contractDigest,
                    input.request.indexId,
                    input.request.order,
                    basePrefix ?? new Uint8Array(),
                    upper ?? new Uint8Array(),
                ],
            ),
            empty: basePrefix !== undefined
                && upper !== undefined
                && comparePluginCollectionIndexSortKeysV1(basePrefix, upper) >= 0,
        };
    }

    const descendingRange = rangeField?.direction === "desc";
    const lower = descendingRange
        ? upperValuePrefix ?? basePrefix
        : lowerValuePrefix ?? basePrefix;
    const upper = descendingRange
        ? nextDirectQueryPrefix(lowerValuePrefix ?? basePrefix)
        : nextDirectQueryPrefix(upperValuePrefix ?? basePrefix);
    return {
        ...(lower !== undefined ? { lower } : {}),
        ...(upper !== undefined ? { upper } : {}),
        queryFingerprint: computeCanonicalDomainSeparatedDigest(
            "happier.plugin.collection-query.cursor.v1",
            [
                input.accountId,
                input.contract.pluginId,
                input.contract.collectionId,
                input.contract.contractDigest,
                input.request.indexId,
                input.request.order,
                lower ?? new Uint8Array(),
                upper ?? new Uint8Array(),
            ],
        ),
        empty: lower !== undefined
            && upper !== undefined
            && comparePluginCollectionIndexSortKeysV1(lower, upper) >= 0,
    };
}

function readContentEnvelopeForCurrentMode(value: unknown, encryptionMode: "plain" | "e2ee") {
    try {
        return assertPluginCollectionContentEnvelopeForModeV1(value, encryptionMode);
    } catch {
        throw new PluginCollectionReadOperationError("collection_content_mode_mismatch");
    }
}

function materializeDirectCollectionRow(input: Readonly<{
    current: Readonly<{
        account: AccountQueryCurrentness;
        contract: NormalizedPluginAccountCollectionContractV1;
    }>;
    row: Readonly<{
        rowId: string;
        revision: number;
        contentEnvelope: unknown;
        projections: readonly Readonly<{
            fieldId: string;
            typedEncodedValue: string;
            rowRevision: number;
        }>[];
    }>;
}>): PluginCollectionRowV1 {
    const content = readContentEnvelopeForCurrentMode(
        input.row.contentEnvelope,
        input.current.account.encryptionMode,
    );
    const expectedFields = input.current.contract.serverReadable;
    if (input.row.projections.length !== expectedFields.length) {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
    const projections = new Map(input.row.projections.map((projection) => [projection.fieldId, projection]));
    if (projections.size !== expectedFields.length) {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
    const projection: Record<string, null | boolean | string | number> = {};
    for (const field of expectedFields) {
        const stored = projections.get(field);
        if (!stored || stored.rowRevision !== input.row.revision) {
            throw new PluginCollectionReadOperationError("collection_index_not_ready");
        }
        projection[field] = projectionValue({
            encoded: stored.typedEncodedValue,
            kind: scalarKindForContractField(input.current.contract, field),
        });
    }
    try {
        return PluginCollectionRowV1Schema.parse({
            rowId: input.row.rowId,
            revision: input.row.revision,
            content,
            projection,
        });
    } catch {
        throw new PluginCollectionReadOperationError("collection_contract_inconsistent");
    }
}

/**
 * Canonical authenticated direct row reader. It resolves the Account-owned
 * current contract on every operation and never accepts caller contract,
 * Account, release, or raw database identity authority.
 */
export async function getPluginCollection(input: Readonly<{
    accountId: string;
    request: PluginCollectionGetRequestV1;
}>): Promise<PluginCollectionGetResultV1> {
    const current = await resolveCurrentContract(input);
    const row = await db.pluginCollectionRow.findFirst({
        where: {
            accountId: input.accountId,
            pluginId: current.contract.pluginId,
            collectionId: current.contract.collectionId,
            schemaVersion: current.contract.schemaVersion,
            contractDigest: current.contract.contractDigest,
            rowId: input.request.rowId,
            deletedAt: null,
        },
        select: {
            rowId: true,
            revision: true,
            contentEnvelope: true,
            projections: {
                select: {
                    fieldId: true,
                    typedEncodedValue: true,
                    rowRevision: true,
                },
            },
        },
    });
    const absenceEpoch = await db.pluginCollectionAbsenceEpoch.findUnique({
        where: { accountId_pluginId_collectionId: {
            accountId: input.accountId,
            pluginId: current.contract.pluginId,
            collectionId: current.contract.collectionId,
        } },
        select: { epoch: true },
    });
    const result = PluginCollectionGetResultV1Schema.parse({
        row: row
            ? materializeDirectCollectionRow({ current, row })
            : null,
        absenceEpoch: absenceEpoch?.epoch ?? 0,
    });
    await readCurrentAccountChangeCursor({
        accountId: input.accountId,
        expectedMode: current.account.encryptionMode,
    });
    return result;
}

/**
 * Canonical authenticated direct bounded-index reader. Static UI queries
 * remain a constrained adapter in this same module; they do not establish a
 * parallel cursor, index, or Account-currentness owner.
 */
export async function queryPluginCollection(input: Readonly<{
    accountId: string;
    request: PluginCollectionQueryRequestV1;
}>): Promise<PluginCollectionQueryResultV1> {
    const snapshot = await inTx(async (tx) => {
        const current = await resolveCurrentContract(input, tx);
        const bounds = buildDirectQueryBounds({
            accountId: input.accountId,
            contract: current.contract,
            request: input.request,
        });
        const page = await readCollectionIndexPageInTx({
            tx,
            accountId: input.accountId,
            current,
            indexId: input.request.indexId,
            bounds,
            cursor: input.request.cursor,
            order: input.request.order,
            limit: input.request.limit,
            error: (code) => new PluginCollectionReadOperationError(code),
        });
        const resultRows = page.pageEntries.map((entry) => {
            const row = page.rowsById.get(entry.rowId);
            if (!row || row.revision !== entry.rowRevision) {
                throw new PluginCollectionReadOperationError("collection_index_not_ready");
            }
            return materializeDirectCollectionRow({ current, row });
        });
        return {
            result: PluginCollectionQueryResultV1Schema.parse({
                rows: resultRows,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                // Rows and this cursor are read from this one transaction
                // snapshot. A later mutation remains observable to watch.
                changeCursor: current.account.changeCursor,
            }),
            expectedMode: current.account.encryptionMode,
        };
    });
    // Recheck the Account mode after materializing row content so a mode
    // transition cannot disclose data under the no-longer-current policy.
    // Deliberately discard this later cursor: the response rows and cursor
    // already belong to the one transaction snapshot above.
    await readCurrentAccountChangeCursor({
        accountId: input.accountId,
        expectedMode: snapshot.expectedMode,
    });
    return snapshot.result;
}

/**
 * Canonical server-side reader for one statically admitted UI query. It has no
 * dynamic predicate, release/artifact lookup, local cache, or caller-supplied
 * Account/contract/index authority.
 */
export async function queryPluginCollectionUiQuery(input: Readonly<{
    accountId: string;
    request: PluginCollectionUiQueryRequestV1;
}>): Promise<PluginCollectionUiQueryResultV1> {
    const snapshot = await inTx(async (tx) => {
        const current = await resolveCurrentContract(input, tx);
        const descriptor = current.contract.uiQueries.find((candidate) => candidate.id === input.request.uiQueryId);
        if (!descriptor) throw new PluginCollectionUiQueryOperationError("collection_query_invalid");
        const bounds = buildQueryBounds({
            accountId: input.accountId,
            contract: current.contract,
            descriptor,
            request: input.request,
        });
        const fields = descriptor.projectedFields.map((field) => field.field);
        const page = await readCollectionIndexPageInTx({
            tx,
            accountId: input.accountId,
            current,
            indexId: descriptor.indexId,
            bounds,
            cursor: input.request.cursor,
            order: descriptor.order,
            limit: descriptor.pageSize,
            projectedFields: fields,
            error: (code) => new PluginCollectionUiQueryOperationError(code),
        });
        const resultRows = page.pageEntries.map((entry) => {
            const row = page.rowsById.get(entry.rowId);
            if (!row || row.revision !== entry.rowRevision) {
                throw new PluginCollectionUiQueryOperationError("collection_index_not_ready");
            }
            assertContentEnvelopeMode(row.contentEnvelope, current.account.encryptionMode);
            const projections = new Map(row.projections.map((projection) => [projection.fieldId, projection]));
            const projectedFields: Record<string, null | boolean | string | number> = {};
            for (const field of descriptor.projectedFields) {
                const projection = projections.get(field.field);
                if (!projection || projection.rowRevision !== row.revision) {
                    throw new PluginCollectionUiQueryOperationError("collection_index_not_ready");
                }
                projectedFields[field.field] = projectionValue({
                    encoded: projection.typedEncodedValue,
                    kind: field.kind,
                });
            }
            return {
                context: {
                    collection: {
                        pluginId: current.contract.pluginId,
                        collectionId: current.contract.collectionId,
                    },
                    rowId: row.rowId,
                    revision: row.revision,
                },
                fields: projectedFields,
            };
        });
        const result = PluginCollectionUiQueryResultV1Schema.parse({
            rows: resultRows,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            // The static adapter consumes the direct reader's same snapshot
            // contract; it is not an independent cursor owner.
            changeCursor: current.account.changeCursor,
        });
        try {
            return {
                result: validatePluginCollectionUiQueryResultV1(descriptor, result),
                expectedMode: current.account.encryptionMode,
            };
        } catch {
            throw new PluginCollectionUiQueryOperationError("collection_contract_inconsistent");
        }
    });
    // Match the direct reader's post-materialization mode validation without
    // advancing the cursor returned from its transaction snapshot.
    await readCurrentAccountChangeCursor({
        accountId: input.accountId,
        expectedMode: snapshot.expectedMode,
    });
    return snapshot.result;
}
