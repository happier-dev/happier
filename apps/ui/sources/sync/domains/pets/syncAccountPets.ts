import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { listAccountPets } from "@/sync/api/pets/apiAccountPets";
import { getServerFeaturesSnapshot } from "@/sync/api/capabilities/serverFeaturesClient";
import { readServerEnabledBit } from "@happier-dev/protocol";

import type { AccountPetMetadata } from "./accountPetLibraryTypes";

type AccountPetsSyncDecisionParams = Readonly<{
    serverId?: string;
    timeoutMs?: number;
}>;

export type FetchAndApplyAccountPetsResult =
    | Readonly<{ status: "applied"; count: number }>
    | Readonly<{ status: "disabled" }>
    | Readonly<{ status: "cancelled" }>;

export type FetchAndApplyAccountPetsParams = Readonly<{
    credentials: AuthCredentials;
    serverId?: string;
    timeoutMs?: number;
    shouldContinue?: () => boolean;
    resolvePetsSyncEnabled?: (params: AccountPetsSyncDecisionParams) => Promise<boolean>;
    listPets?: (credentials: AuthCredentials) => Promise<AccountPetMetadata[]>;
    applyAccountPets: (pets: AccountPetMetadata[]) => void;
}>;

function buildDecisionParams(params: FetchAndApplyAccountPetsParams): AccountPetsSyncDecisionParams {
    const decisionParams: { serverId?: string; timeoutMs?: number } = {};
    const serverId = String(params.serverId ?? "").trim();
    if (serverId.length > 0) {
        decisionParams.serverId = serverId;
    }
    if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
        decisionParams.timeoutMs = Math.trunc(params.timeoutMs);
    }
    return decisionParams;
}

async function resolveDefaultPetsSyncEnabled(params: AccountPetsSyncDecisionParams): Promise<boolean> {
    const snapshot = await getServerFeaturesSnapshot(params);
    return snapshot.status === "ready" && readServerEnabledBit(snapshot.features, "pets.sync") === true;
}

export async function fetchAndApplyAccountPets(
    params: FetchAndApplyAccountPetsParams,
): Promise<FetchAndApplyAccountPetsResult> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return { status: "cancelled" };

    const resolvePetsSyncEnabled = params.resolvePetsSyncEnabled ?? resolveDefaultPetsSyncEnabled;
    const petsSyncEnabled = await resolvePetsSyncEnabled(buildDecisionParams(params));
    if (!shouldContinue()) return { status: "cancelled" };

    if (!petsSyncEnabled) {
        params.applyAccountPets([]);
        return { status: "disabled" };
    }

    const listPets = params.listPets ?? listAccountPets;
    const pets = await listPets(params.credentials);
    if (!shouldContinue()) return { status: "cancelled" };

    params.applyAccountPets(pets);
    return { status: "applied", count: pets.length };
}
