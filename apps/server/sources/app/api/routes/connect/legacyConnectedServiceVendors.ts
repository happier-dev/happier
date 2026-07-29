import { AGENTS_CORE } from "@happier-dev/agents";
import {
    ConnectedServiceCloudVendorKeySchema,
    type ConnectedServiceCloudVendorKey,
} from "@happier-dev/protocol";

type LegacyConnectedServiceVendorCore = Readonly<{
    cloudConnect?: Readonly<{
        vendorKey: string;
    }> | null;
}>;

type LegacyConnectedServiceVendorRow = Readonly<{
    vendor: string | null;
    profileId: string | null;
}>;

export function collectLegacyConnectedServiceVendorKeys(
    agentCores: Readonly<Record<string, LegacyConnectedServiceVendorCore>>,
): ConnectedServiceCloudVendorKey[] {
    const seen = new Set<ConnectedServiceCloudVendorKey>();
    const vendorKeys: ConnectedServiceCloudVendorKey[] = [];

    for (const agentCore of Object.values(agentCores)) {
        const parsedVendorKey = ConnectedServiceCloudVendorKeySchema.safeParse(agentCore.cloudConnect?.vendorKey);
        if (!parsedVendorKey.success) continue;

        const vendorKey = parsedVendorKey.data;
        if (seen.has(vendorKey)) continue;

        seen.add(vendorKey);
        vendorKeys.push(vendorKey);
    }

    return vendorKeys;
}

export function collectLegacyConnectedServiceVendorKeysFromRows(
    rows: ReadonlyArray<LegacyConnectedServiceVendorRow>,
): ConnectedServiceCloudVendorKey[] {
    const seen = new Set<ConnectedServiceCloudVendorKey>();
    const vendorKeys: ConnectedServiceCloudVendorKey[] = [];

    for (const row of rows) {
        if (row.profileId !== "default") continue;
        const parsedVendorKey = ConnectedServiceCloudVendorKeySchema.safeParse(row.vendor);
        if (!parsedVendorKey.success) continue;

        const vendorKey = parsedVendorKey.data;
        if (seen.has(vendorKey)) continue;

        seen.add(vendorKey);
        vendorKeys.push(vendorKey);
    }

    return vendorKeys;
}

export const LEGACY_CONNECTED_SERVICE_VENDOR_KEYS = collectLegacyConnectedServiceVendorKeys(
    AGENTS_CORE as Readonly<Record<string, LegacyConnectedServiceVendorCore>>,
);

const LEGACY_CONNECTED_SERVICE_VENDOR_KEY_SET = new Set(LEGACY_CONNECTED_SERVICE_VENDOR_KEYS);

export function isLegacyConnectedServiceVendorKey(
    vendor: string,
): vendor is ConnectedServiceCloudVendorKey {
    return LEGACY_CONNECTED_SERVICE_VENDOR_KEY_SET.has(vendor as ConnectedServiceCloudVendorKey);
}
