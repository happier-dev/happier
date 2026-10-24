import { createHash } from "node:crypto";

import {
    ConnectedServiceUsageSourceV1Schema,
    isProviderAccountUsageOrganizationContextMatch,
    ProviderAccountUsageRecordKeyV1Schema,
    type ConnectedServiceUsageSourceV1,
} from "@happier-dev/protocol";
import { AGENTS_CORE } from "@happier-dev/agents";

import { db } from "@/storage/db";
import type { TransactionClient } from "@/storage/prisma";
import { UpsertConnectedServiceUsageSourceSchema } from "./schemas";
import type {
    StoredConnectedServiceUsageSource,
    UpsertConnectedServiceUsageSourceParams,
} from "./types";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
} from "./types";

type ConnectedServiceUsageSourceClient = Pick<
    typeof db,
    "providerAccountUsageRecord" | "serviceAccountToken" | "connectedServiceAuthGroupMember" | "connectedServiceUsageSource"
> | Pick<
    TransactionClient,
    "providerAccountUsageRecord" | "serviceAccountToken" | "connectedServiceAuthGroupMember" | "connectedServiceUsageSource"
>;

type AgentConnectedServiceSupport = Readonly<{
    connectedServices?: Readonly<{
        supportedServiceIds: ReadonlyArray<string>;
    }> | null;
}>;

type ConnectedServiceBindingIdentity = Readonly<{
    providerAccountId: string | null;
    providerOrganizationId: string | null;
}>;
type ProviderAccountUsageRecordIdentity = Readonly<{
    providerId: string;
    accountSubjectId: string;
    subjectKind: string;
    quotaScope: string;
    quotaScopeId: string | null;
}>;

const AGENTS_BY_PROVIDER_ID: Readonly<Record<string, AgentConnectedServiceSupport>> = AGENTS_CORE;

function readRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCredentialBindingIdentity(metadata: unknown): ConnectedServiceBindingIdentity {
    const record = readRecord(metadata);
    return {
        providerAccountId: readString(record?.providerAccountId),
        providerOrganizationId: readString(record?.providerOrganizationId),
    };
}

function buildConnectedServiceUsageSourceKey(source: ConnectedServiceUsageSourceV1): string {
    const tuple = source.bindingKind === "group_member"
        ? ["group", source.serviceId, source.profileId, source.groupId, source.groupGeneration ?? "current"]
        : ["profile", source.serviceId, source.profileId];
    const digest = createHash("sha256").update(JSON.stringify(tuple)).digest("base64url");
    return `csus_v1_${digest}`;
}

function mapStoredConnectedServiceUsageSource(row: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    sourceKey: string;
    providerAccountUsageRecordId: string;
    bindingKind: string;
    groupId: string | null;
    groupGeneration: number | null;
}>): StoredConnectedServiceUsageSource {
    const parsedSource = ConnectedServiceUsageSourceV1Schema.safeParse({
        serviceId: row.serviceId,
        profileId: row.profileId,
        bindingKind: row.bindingKind,
        ...(row.groupId !== null ? { groupId: row.groupId } : {}),
        ...(row.groupGeneration !== null ? { groupGeneration: row.groupGeneration } : {}),
    });
    if (!parsedSource.success) {
        throw new ConnectedServiceUsageSourceBindingError("Stored connected service usage source has an invalid binding shape");
    }
    return {
        accountId: row.accountId,
        sourceKey: row.sourceKey,
        providerAccountUsageRecordId: row.providerAccountUsageRecordId as StoredConnectedServiceUsageSource["providerAccountUsageRecordId"],
        ...parsedSource.data,
    };
}

export function toConnectedServiceUsageSourceV1(
    source: StoredConnectedServiceUsageSource,
): ConnectedServiceUsageSourceV1 {
    return source.bindingKind === "profile"
        ? ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: source.serviceId,
            profileId: source.profileId,
            bindingKind: "profile",
        })
        : ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: source.serviceId,
            profileId: source.profileId,
            bindingKind: "group_member",
            groupId: source.groupId,
            ...(source.groupGeneration !== undefined ? { groupGeneration: source.groupGeneration } : {}),
        });
}

function isProviderUsageRecordCompatibleWithConnectedService(params: Readonly<{
    providerId: string;
    serviceId: string;
}>): boolean {
    const providerId = params.providerId.trim();
    const serviceId = params.serviceId.trim();
    if (!providerId || !serviceId) return false;
    if (providerId === serviceId) return true;
    const provider = AGENTS_BY_PROVIDER_ID[providerId];
    return provider?.connectedServices?.supportedServiceIds.includes(serviceId) === true;
}

export function assertProviderUsageRecordCompatibleWithConnectedServiceSource(params: Readonly<{
    providerId: string;
    serviceId: string;
}>): void {
    if (!isProviderUsageRecordCompatibleWithConnectedService(params)) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record is not compatible with the connected-service source");
    }
}

async function isStoredConnectedServiceUsageSourceActive(
    source: StoredConnectedServiceUsageSource,
    client: ConnectedServiceUsageSourceClient,
    options?: Readonly<{ requireGroupGenerationMatch?: boolean }>,
): Promise<boolean> {
    try {
        const record = await resolveLinkedProviderUsageRecordIdentity(source, client);
        assertProviderUsageRecordCompatibleWithConnectedServiceSource({
            providerId: record.providerId,
            serviceId: source.serviceId,
        });
        let bindingIdentity: ConnectedServiceBindingIdentity;
        if (source.bindingKind === "profile") {
            bindingIdentity = await resolveProfileBinding(source, client);
        } else {
            bindingIdentity = (await resolveGroupBinding({
                accountId: source.accountId,
                serviceId: source.serviceId,
                profileId: source.profileId,
                groupId: source.groupId,
                groupGeneration: source.groupGeneration,
                requireGenerationMatch: options?.requireGroupGenerationMatch ?? false,
            }, client)).identity;
        }
        assertConnectedServiceBindingIdentityMatchesProviderUsageRecord({
            record,
            bindingIdentity,
        });
        return true;
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            || error instanceof ConnectedServiceUsageSourceOwnershipError
        ) return false;
        throw error;
    }
}

async function resolveLinkedProviderUsageRecordIdentity(
    source: StoredConnectedServiceUsageSource,
    client: ConnectedServiceUsageSourceClient,
): Promise<ProviderAccountUsageRecordIdentity> {
    const record = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: source.accountId,
                recordId: source.providerAccountUsageRecordId,
            },
        },
        select: { providerId: true, accountSubjectId: true, subjectKind: true, quotaScope: true, quotaScopeId: true },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record does not belong to the source account");
    }
    return record;
}

async function resolveProfileBinding(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient): Promise<ConnectedServiceBindingIdentity> {
    const binding = await client.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { metadata: true },
    });
    if (!binding) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service profile binding does not exist", "unavailable");
    }
    return readCredentialBindingIdentity(binding.metadata);
}

async function resolveGroupBinding(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    groupId?: string;
    groupGeneration?: number;
    requireGenerationMatch?: boolean;
}>, client: ConnectedServiceUsageSourceClient): Promise<Readonly<{
    groupGeneration: number;
    identity: ConnectedServiceBindingIdentity;
}>> {
    if (!params.groupId) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member sources require groupId");
    }
    const member = await client.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: {
            enabled: true,
            group: { select: { generation: true } },
            credential: { select: { metadata: true } },
        },
    });
    if (!member || !member.enabled) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member binding is missing or disabled", "unavailable");
    }
    if (params.requireGenerationMatch !== false && params.groupGeneration !== undefined && member.group.generation !== params.groupGeneration) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member generation does not match the active group generation", "unavailable");
    }
    return {
        groupGeneration: params.groupGeneration ?? member.group.generation,
        identity: readCredentialBindingIdentity(member.credential.metadata),
    };
}

function assertConnectedServiceBindingIdentityMatchesProviderUsageRecord(params: Readonly<{
    record: ProviderAccountUsageRecordIdentity;
    bindingIdentity: ConnectedServiceBindingIdentity;
}>): void {
    if (!params.bindingIdentity.providerAccountId) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Connected-service credential does not expose provider account identity",
            "unproven",
        );
    }
    if (params.record.subjectKind !== "account") {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Provider account usage record does not expose a verifiable account subject",
            "unproven",
        );
    }
    if (params.bindingIdentity.providerAccountId !== params.record.accountSubjectId) {
        throw new ConnectedServiceUsageSourceOwnershipError("Connected-service credential identity does not match provider account usage record");
    }
    if (params.bindingIdentity.providerOrganizationId || params.record.quotaScope === "organization") {
        const recordKey = ProviderAccountUsageRecordKeyV1Schema.parse({
            providerId: params.record.providerId,
            accountSubjectId: params.record.accountSubjectId,
            subjectKind: params.record.subjectKind,
            quotaScope: params.record.quotaScope,
            quotaScopeId: params.record.quotaScopeId ?? undefined,
        });
        if (!isProviderAccountUsageOrganizationContextMatch(recordKey, params.bindingIdentity)) {
            throw new ConnectedServiceUsageSourceOwnershipError(
                "Connected-service credential organization does not match provider account usage record",
                params.bindingIdentity.providerOrganizationId ? "mismatch" : "unproven",
            );
        }
    }
}

export async function upsertConnectedServiceUsageSource(
    raw: UpsertConnectedServiceUsageSourceParams,
    client: ConnectedServiceUsageSourceClient = db,
): Promise<StoredConnectedServiceUsageSource> {
    const parsed = UpsertConnectedServiceUsageSourceSchema.parse(raw);
    const record = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: parsed.accountId,
                recordId: parsed.providerAccountUsageRecordId,
            },
        },
        select: { recordId: true, providerId: true, accountSubjectId: true, subjectKind: true, quotaScope: true, quotaScopeId: true },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record does not belong to the source account");
    }
    assertProviderUsageRecordCompatibleWithConnectedServiceSource({
        providerId: record.providerId,
        serviceId: parsed.serviceId,
    });

    let bindingIdentity: ConnectedServiceBindingIdentity;
    let source: ConnectedServiceUsageSourceV1;
    if (parsed.bindingKind === "profile") {
        bindingIdentity = await resolveProfileBinding(parsed, client);
        source = parsed;
    } else {
        const groupBinding = await resolveGroupBinding(parsed, client);
        bindingIdentity = groupBinding.identity;
        source = {
            ...parsed,
            groupGeneration: groupBinding.groupGeneration,
        };
    }
    assertConnectedServiceBindingIdentityMatchesProviderUsageRecord({
        record,
        bindingIdentity,
    });

    const sourceKey = buildConnectedServiceUsageSourceKey(source);

    // Source identity is the full sourceKey (serviceId + profileId + group identity),
    // NOT the profile tuple: one profile can belong to multiple auth groups, and each
    // group's link owns a distinct sourceKey. Keying the upsert by sourceKey lets those
    // per-group links coexist instead of the second silently overwriting the first.
    const row = await client.connectedServiceUsageSource.upsert({
        where: {
            accountId_sourceKey: {
                accountId: parsed.accountId,
                sourceKey,
            },
        },
        create: {
            accountId: parsed.accountId,
            serviceId: parsed.serviceId,
            profileId: parsed.profileId,
            sourceKey,
            providerAccountUsageRecordId: parsed.providerAccountUsageRecordId,
            bindingKind: source.bindingKind,
            ...(source.bindingKind === "group_member" ? {
                groupId: source.groupId,
                ...(source.groupGeneration !== undefined ? { groupGeneration: source.groupGeneration } : {}),
            } : {}),
        },
        update: {
            providerAccountUsageRecordId: parsed.providerAccountUsageRecordId,
            bindingKind: source.bindingKind,
            groupId: source.bindingKind === "group_member" ? source.groupId : null,
            groupGeneration: source.bindingKind === "group_member" ? source.groupGeneration ?? null : null,
        },
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    if (source.bindingKind === "group_member") {
        // SD-2: the sourceKey embeds the group generation, so every generation bump mints a NEW
        // row for the SAME logical link (service + profile + group) and the superseded row would
        // accumulate forever. Prune superseded generations of this exact logical source here, at
        // the single write owner. Scoped by groupId so a profile's links to OTHER groups coexist
        // untouched, and only fired on a fresh upsert so a stale-generation row with no newer
        // sibling stays readable (the reader intentionally tolerates it).
        await client.connectedServiceUsageSource.deleteMany({
            where: {
                accountId: parsed.accountId,
                serviceId: parsed.serviceId,
                profileId: parsed.profileId,
                bindingKind: "group_member",
                groupId: source.groupId,
                sourceKey: { not: sourceKey },
            },
        });
    }
    return mapStoredConnectedServiceUsageSource(row);
}

export async function readConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource | null> {
    // A profile can now hold several coexisting links (one per group it belongs to,
    // plus an optional profile-level link). They are identity-bound to the same
    // credential, so any active one resolves to the same provider usage record; return
    // the first active match under a deterministic order.
    const rows = await client.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
        orderBy: [
            { bindingKind: "asc" },
            { sourceKey: "asc" },
        ],
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    for (const row of rows) {
        const source = mapStoredConnectedServiceUsageSource(row);
        if (await isStoredConnectedServiceUsageSourceActive(source, client)) {
            return source;
        }
    }
    return null;
}

export type ExactConnectedServiceUsageSourceResolution = Readonly<{
    source: ConnectedServiceUsageSourceV1;
    recordId: StoredConnectedServiceUsageSource["providerAccountUsageRecordId"];
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
}>;

/**
 * Resolves one exact current source tuple for the authenticated account.
 *
 * Unlike the settings-oriented profile reader, group-member resolution requires the supplied
 * generation to still equal authoritative group truth. This makes the result suitable as startup
 * hydration proof without changing the intentionally tolerant settings projection.
 */
export async function readExactConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    source: ConnectedServiceUsageSourceV1;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<ExactConnectedServiceUsageSourceResolution | null> {
    const source = ConnectedServiceUsageSourceV1Schema.parse(params.source);
    const sourceKey = buildConnectedServiceUsageSourceKey(source);
    const row = await client.connectedServiceUsageSource.findUnique({
        where: {
            accountId_sourceKey: {
                accountId: params.accountId,
                sourceKey,
            },
        },
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    if (!row) return null;

    const storedSource = mapStoredConnectedServiceUsageSource(row);
    if (!await isStoredConnectedServiceUsageSourceActive(storedSource, client, {
        requireGroupGenerationMatch: true,
    })) return null;

    const record = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: params.accountId,
                recordId: storedSource.providerAccountUsageRecordId,
            },
        },
        select: {
            accountSubjectId: true,
            subjectKind: true,
            fetchedAt: true,
            staleAfterMs: true,
        },
    });
    if (!record || record.subjectKind !== "account") return null;

    return {
        source: toConnectedServiceUsageSourceV1(storedSource),
        recordId: storedSource.providerAccountUsageRecordId,
        providerAccountId: record.accountSubjectId,
        fetchedAt: record.fetchedAt?.getTime() ?? null,
        staleAfterMs: record.staleAfterMs,
    };
}

export async function listConnectedServiceUsageSourcesForProviderAccountUsageRecord(params: Readonly<{
    accountId: string;
    providerAccountUsageRecordId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource[]> {
    const rows = await client.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            providerAccountUsageRecordId: params.providerAccountUsageRecordId,
        },
        orderBy: [
            { serviceId: "asc" },
            { profileId: "asc" },
        ],
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    const activeSources: StoredConnectedServiceUsageSource[] = [];
    for (const row of rows) {
        const source = mapStoredConnectedServiceUsageSource(row);
        if (await isStoredConnectedServiceUsageSourceActive(source, client)) {
            activeSources.push(source);
        }
    }
    return activeSources;
}

export async function unlinkConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<"removed" | "not_found"> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
    });
    return deleted.count > 0 ? "removed" : "not_found";
}

export async function deleteConnectedServiceUsageSourcesForProfile(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
    });
    return deleted.count;
}

export async function deleteConnectedServiceUsageSourcesForGroup(params: Readonly<{
    accountId: string;
    serviceId: string;
    groupId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            bindingKind: "group_member",
            groupId: params.groupId,
        },
    });
    return deleted.count;
}

export async function deleteConnectedServiceUsageSourcesForGroupMember(params: Readonly<{
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
            bindingKind: "group_member",
            groupId: params.groupId,
        },
    });
    return deleted.count;
}

export async function deleteConnectedServiceUsageSourcesForAccount(params: Readonly<{
    accountId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: { accountId: params.accountId },
    });
    return deleted.count;
}

export async function linkConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    providerAccountUsageRecordId: string;
    source: ConnectedServiceUsageSourceV1;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource> {
    return await upsertConnectedServiceUsageSource({
        accountId: params.accountId,
        providerAccountUsageRecordId: params.providerAccountUsageRecordId as StoredConnectedServiceUsageSource["providerAccountUsageRecordId"],
        ...params.source,
    }, client);
}
