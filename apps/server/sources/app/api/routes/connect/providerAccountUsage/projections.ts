import { ConnectedServiceUsageSourceV1Schema, projectProviderAccountUsageToConnectedServiceQuotaSnapshot } from "@happier-dev/protocol";

import { readProviderAccountUsageRecord } from "./recordStorage";
import { readConnectedServiceUsageSource } from "./sourceStorage";
import { requestProviderAccountUsageRefresh } from "./recordStorage";
import type { ConnectedServiceQuotaView, ProviderAccountUsageStatus } from "./types";

function normalizeResponseStatus(status: ProviderAccountUsageStatus): Exclude<ProviderAccountUsageStatus, "refresh_requested"> {
    return status === "refresh_requested" ? "ok" : status;
}

export async function readConnectedServiceQuotaView(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<ConnectedServiceQuotaView | null> {
    const source = await readConnectedServiceUsageSource(params);
    if (!source) return null;

    const record = await readProviderAccountUsageRecord({
        accountId: params.accountId,
        recordId: source.providerAccountUsageRecordId,
    });
    if (!record?.snapshot) return null;

    const projected = projectProviderAccountUsageToConnectedServiceQuotaSnapshot(record.snapshot, ConnectedServiceUsageSourceV1Schema.parse({
        serviceId: params.serviceId,
        profileId: params.profileId,
        bindingKind: "profile",
    }));
    if (!projected) return null;

    return {
        recordId: record.recordId,
        snapshot: projected,
        metadata: {
            fetchedAt: record.fetchedAt ?? record.snapshot.fetchedAtMs,
            staleAfterMs: record.staleAfterMs ?? record.snapshot.staleAfterMs,
            status: normalizeResponseStatus(record.status),
            ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
        },
    };
}

export async function requestConnectedServiceQuotaRefresh(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): Promise<"written" | "not_found"> {
    const source = await readConnectedServiceUsageSource(params);
    if (!source) return "not_found";
    return await requestProviderAccountUsageRefresh({
        accountId: params.accountId,
        recordId: source.providerAccountUsageRecordId,
    });
}
