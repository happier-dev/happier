import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";
import {
    normalizeProviderAccountUsageAliases,
    projectProviderAccountUsageToConnectedServiceQuotaSnapshot,
    ProviderAccountUsageSnapshotV1Schema,
    type ProviderAccountUsageAliasV1,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";
import { decodeUtf8String, encodeUtf8Bytes, toPrismaBytes } from "./connectedServicesV3/bytesCodec";

export const PROVIDER_ACCOUNT_USAGE_VENDOR = "provider-account-usage";
export const MAX_PROVIDER_ACCOUNT_USAGE_JSON_CHARS = 200_000;
export const MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS = 200_000;

export type ProviderAccountUsageStatus = "ok" | "unavailable" | "estimated" | "error";
export type ProviderAccountUsageStorage = "plain_json_v1" | "server_sealed_json_v1" | "sealed_account_scoped_v1";

export type ProviderAccountUsageMetadataV1 = {
    v: 1;
    kind: "provider_account_usage";
    recordId: string;
    storage: ProviderAccountUsageStorage;
    format?: "account_scoped_v1";
    materialFingerprint?: string;
    refreshRequestedAt?: number;
};

type ProviderAccountUsageRow = Readonly<{
    snapshot: Uint8Array;
    fetchedAt: Date | null;
    staleAfterMs: number | null;
    status: string | null;
    metadata: unknown;
}>;

export type ProviderAccountUsageResponseMetadata = Readonly<{
    fetchedAt: number;
    staleAfterMs: number;
    status: ProviderAccountUsageStatus;
    refreshRequestedAt?: number;
}>;

type ProviderAccountUsageProjection = Readonly<{
    recordId: string;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    metadata: ProviderAccountUsageResponseMetadata;
}>;

type ProviderAccountUsageAliasRemovalResult = "removed" | "deleted" | "not_found";

export function resolveAtRestStoragePolicy(env: NodeJS.ProcessEnv): "none" | "server_sealed" {
    const encryption = readEncryptionFeatureEnv(env);
    return encryption.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";
}

export function isPlainAccountMode(account: Readonly<{ publicKey: string | null; encryptionMode: string | null }>): boolean {
    return resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain";
}

export function buildPlainAtRestKeyPath(params: { accountId: string; recordId: string }): string[] {
    return ["storage", "provider_account_usage", params.accountId, params.recordId, "v1"];
}

export function normalizeProviderAccountUsageStatus(raw: unknown): ProviderAccountUsageStatus {
    return raw === "ok" || raw === "unavailable" || raw === "estimated" || raw === "error" ? raw : "ok";
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
    return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

export function isProviderAccountUsageMetadataV1(raw: unknown): raw is ProviderAccountUsageMetadataV1 {
    if (!isRecord(raw)) return false;
    const storage = raw.storage;
    const format = raw.format;
    return raw.v === 1
        && raw.kind === "provider_account_usage"
        && typeof raw.recordId === "string"
        && (storage === "plain_json_v1" || storage === "server_sealed_json_v1" || storage === "sealed_account_scoped_v1")
        && (format === undefined || format === "account_scoped_v1")
        && (raw.materialFingerprint === undefined || typeof raw.materialFingerprint === "string")
        && (raw.refreshRequestedAt === undefined || typeof raw.refreshRequestedAt === "number");
}

export function readProviderAccountUsageRefreshRequestedAt(metadata: ProviderAccountUsageMetadataV1): number | undefined {
    return typeof metadata.refreshRequestedAt === "number"
        ? Math.max(0, Math.trunc(metadata.refreshRequestedAt))
        : undefined;
}

export function buildProviderAccountUsageResponseMetadata(
    row: ProviderAccountUsageRow,
    metadata: ProviderAccountUsageMetadataV1,
): ProviderAccountUsageResponseMetadata {
    const refreshRequestedAt = readProviderAccountUsageRefreshRequestedAt(metadata);
    return {
        fetchedAt: row.fetchedAt ? row.fetchedAt.getTime() : Date.now(),
        staleAfterMs: typeof row.staleAfterMs === "number" ? row.staleAfterMs : 0,
        status: normalizeProviderAccountUsageStatus(row.status),
        ...(refreshRequestedAt !== undefined ? { refreshRequestedAt } : {}),
    };
}

function decodePlainProviderAccountUsageJson(params: Readonly<{
    accountId: string;
    recordId: string;
    row: ProviderAccountUsageRow;
    metadata: ProviderAccountUsageMetadataV1;
}>): string | null {
    if (params.metadata.storage === "sealed_account_scoped_v1") return null;
    if (params.row.snapshot.byteLength === 0) return null;
    return params.metadata.storage === "server_sealed_json_v1"
        ? decryptString(buildPlainAtRestKeyPath(params), toPrismaBytes(params.row.snapshot))
        : decodeUtf8String(params.row.snapshot);
}

export function parsePlainProviderAccountUsageSnapshot(params: Readonly<{
    accountId: string;
    recordId: string;
    row: ProviderAccountUsageRow;
    metadata: ProviderAccountUsageMetadataV1;
}>): ProviderAccountUsageSnapshotV1 | null {
    const json = decodePlainProviderAccountUsageJson(params);
    if (!json?.trim()) return null;

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(json);
    } catch {
        return null;
    }

    const snapshot = ProviderAccountUsageSnapshotV1Schema.safeParse(parsedJson);
    if (!snapshot.success) return null;
    return snapshot.data.recordId === params.recordId ? snapshot.data : null;
}

export async function readProviderAccountUsageRow(params: Readonly<{
    accountId: string;
    recordId: string;
}>): Promise<ProviderAccountUsageRow | null> {
    return await db.serviceAccountQuotaSnapshot.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
                profileId: params.recordId,
            },
        },
        select: { snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true },
    });
}

export async function readProviderAccountUsageProjectionForConnectedService(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<ProviderAccountUsageProjection | null> {
    const pageSize = 100;
    for (let skip = 0; ; skip += pageSize) {
        const rows = await db.serviceAccountQuotaSnapshot.findMany({
            where: {
                accountId: params.accountId,
                vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            },
            select: { snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true, profileId: true },
            orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
            skip,
            take: pageSize,
        });
        if (rows.length === 0) return null;

        for (const row of rows) {
            if (!isProviderAccountUsageMetadataV1(row.metadata)) continue;
            const snapshot = parsePlainProviderAccountUsageSnapshot({
                accountId: params.accountId,
                recordId: row.profileId,
                row,
                metadata: row.metadata,
            });
            if (!snapshot) continue;

            const projected = projectProviderAccountUsageToConnectedServiceQuotaSnapshot(snapshot, {
                serviceId: params.serviceId,
                profileId: params.profileId,
            });
            if (!projected) continue;

            return {
                recordId: row.profileId,
                snapshot: projected,
                metadata: buildProviderAccountUsageResponseMetadata(row, row.metadata),
            };
        }
    }
}

export async function mergeProviderAccountUsageSnapshotWithStoredAliases(params: Readonly<{
    accountId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<ProviderAccountUsageSnapshotV1> {
    const incomingSnapshot = ProviderAccountUsageSnapshotV1Schema.parse({
        ...params.snapshot,
        aliases: normalizeProviderAccountUsageAliases(params.snapshot.aliases),
    });
    const row = await readProviderAccountUsageRow({
        accountId: params.accountId,
        recordId: incomingSnapshot.recordId,
    });
    if (!row || !isProviderAccountUsageMetadataV1(row.metadata)) return incomingSnapshot;

    const existingSnapshot = parsePlainProviderAccountUsageSnapshot({
        accountId: params.accountId,
        recordId: incomingSnapshot.recordId,
        row,
        metadata: row.metadata,
    });
    if (!existingSnapshot) return incomingSnapshot;

    return ProviderAccountUsageSnapshotV1Schema.parse({
        ...incomingSnapshot,
        aliases: normalizeProviderAccountUsageAliases([
            ...existingSnapshot.aliases,
            ...incomingSnapshot.aliases,
        ]),
    });
}

function isConnectedServiceProjectionAlias(
    alias: ProviderAccountUsageAliasV1,
    target: Readonly<{ serviceId: string; profileId: string }>,
): boolean {
    return (alias.kind === "connectedServiceProfile" || alias.kind === "connectedServiceGroupMember")
        && alias.serviceId === target.serviceId
        && alias.profileId === target.profileId;
}

export async function removeConnectedServiceAliasFromProviderAccountUsageProjection(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<ProviderAccountUsageAliasRemovalResult> {
    const projection = await readProviderAccountUsageProjectionForConnectedService(params);
    if (!projection) return "not_found";

    const row = await db.serviceAccountQuotaSnapshot.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
                profileId: projection.recordId,
            },
        },
        select: { id: true, snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true },
    });
    if (!row || !isProviderAccountUsageMetadataV1(row.metadata)) return "not_found";

    const snapshot = parsePlainProviderAccountUsageSnapshot({
        accountId: params.accountId,
        recordId: projection.recordId,
        row,
        metadata: row.metadata,
    });
    if (!snapshot) return "not_found";

    const remainingAliases = normalizeProviderAccountUsageAliases(
        snapshot.aliases.filter((alias) => !isConnectedServiceProjectionAlias(alias, params)),
    );
    if (remainingAliases.length === snapshot.aliases.length) return "not_found";

    if (remainingAliases.length === 0) {
        await db.serviceAccountQuotaSnapshot.delete({ where: { id: row.id } });
        return "deleted";
    }

    const nextSnapshot = ProviderAccountUsageSnapshotV1Schema.parse({
        ...snapshot,
        aliases: [...remainingAliases],
    });
    const json = JSON.stringify(nextSnapshot);
    if (json.length > MAX_PROVIDER_ACCOUNT_USAGE_JSON_CHARS) return "not_found";

    const bytes = row.metadata.storage === "server_sealed_json_v1"
        ? encryptString(buildPlainAtRestKeyPath({ accountId: params.accountId, recordId: projection.recordId }), json)
        : encodeUtf8Bytes(json);
    const metadata = buildProviderAccountUsageMetadata({
        recordId: projection.recordId,
        storage: row.metadata.storage,
        format: row.metadata.format,
        refreshRequestedAt: row.metadata.refreshRequestedAt,
    });

    await db.serviceAccountQuotaSnapshot.update({
        where: { id: row.id },
        data: {
            updatedAt: new Date(),
            snapshot: toPrismaBytes(bytes),
            metadata,
        },
    });
    return "removed";
}

export function buildProviderAccountUsageMetadata(params: Readonly<{
    recordId: string;
    storage: ProviderAccountUsageStorage;
    format?: "account_scoped_v1";
    materialFingerprint?: string;
    refreshRequestedAt?: number;
}>): ProviderAccountUsageMetadataV1 {
    return {
        v: 1,
        kind: "provider_account_usage",
        recordId: params.recordId,
        storage: params.storage,
        ...(params.format ? { format: params.format } : {}),
        ...(params.materialFingerprint ? { materialFingerprint: params.materialFingerprint } : {}),
        ...(params.refreshRequestedAt !== undefined ? { refreshRequestedAt: params.refreshRequestedAt } : {}),
    };
}

export async function writeProviderAccountUsageRefreshRequest(params: Readonly<{
    accountId: string;
    recordId: string;
    storage: ProviderAccountUsageStorage;
    format?: "account_scoped_v1";
}>): Promise<void> {
    const where = {
        accountId_vendor_profileId: {
            accountId: params.accountId,
            vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            profileId: params.recordId,
        },
    };
    const existing = await db.serviceAccountQuotaSnapshot.findUnique({
        where,
        select: { id: true, metadata: true },
    });
    const existingMetadata = isProviderAccountUsageMetadataV1(existing?.metadata) ? existing.metadata : null;
    const metadata = buildProviderAccountUsageMetadata({
        recordId: params.recordId,
        storage: existingMetadata?.storage ?? params.storage,
        format: existingMetadata?.format ?? params.format,
        materialFingerprint: existingMetadata?.materialFingerprint,
        refreshRequestedAt: Date.now(),
    });

    if (existing) {
        await db.serviceAccountQuotaSnapshot.update({
            where: { id: existing.id },
            data: { updatedAt: new Date(), metadata },
        });
        return;
    }

    try {
        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: params.accountId,
                vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
                profileId: params.recordId,
                snapshot: encodeUtf8Bytes(""),
                status: null,
                fetchedAt: null,
                staleAfterMs: 0,
                metadata,
            },
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        await writeProviderAccountUsageRefreshRequest(params);
    }
}
