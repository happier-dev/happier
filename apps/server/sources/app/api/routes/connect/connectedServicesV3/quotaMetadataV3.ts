export type ConnectedServiceQuotaAtRestStorageV3 =
    | "plain_json_v1"
    | "server_sealed_json_v1";

export type ConnectedServiceQuotaMetadataV3 = Readonly<{
    v: 3;
    storage: ConnectedServiceQuotaAtRestStorageV3;
    refreshRequestedAt?: number;
}>;

export function isConnectedServiceQuotaMetadataV3(raw: unknown): raw is ConnectedServiceQuotaMetadataV3 {
    if (!raw || typeof raw !== "object") return false;
    const rec = raw as any;
    const storageOk = rec.storage === "plain_json_v1" || rec.storage === "server_sealed_json_v1";
    const refreshOk = rec.refreshRequestedAt === undefined || typeof rec.refreshRequestedAt === "number";
    return rec.v === 3 && storageOk && refreshOk;
}

