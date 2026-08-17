import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { listAccountPets } from "@/sync/api/pets/apiAccountPets";
import { getServerFeaturesSnapshot } from "@/sync/api/capabilities/serverFeaturesClient";
import { readServerEnabledBit } from "@happier-dev/protocol";

import type {
    AccountPetMetadata,
    AccountPetsListResponse,
} from "./accountPetLibraryTypes";
import { resolveAccountPetReadAdmission } from "./resolveAccountPetReadAdmission";

type AccountPetsSyncDecisionParams = Readonly<{
    serverId?: string;
    timeoutMs?: number;
}>;

export type FetchAndApplyAccountPetsResult =
    | Readonly<{ status: "applied"; count: number }>
    | Readonly<{ status: "disabled" }>
    | Readonly<{ status: "cancelled" }>
    | Readonly<{
        status: "unavailable";
        reason: "custom_pet_sync_unavailable";
    }>;

export type FetchAndApplyAccountPetsParams = Readonly<{
    credentials: AuthCredentials;
    serverId?: string;
    timeoutMs?: number;
    shouldContinue?: () => boolean;
    resolvePetsSyncEnabled?: (params: AccountPetsSyncDecisionParams) => Promise<boolean>;
    listPets?: (credentials: AuthCredentials) => Promise<AccountPetsListResponse>;
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

    const admission = await resolveAccountPetReadAdmission(params.credentials);
    if (!shouldContinue()) return { status: "cancelled" };
    if (admission.status === "unavailable") return admission;

    const listPets = params.listPets ?? listAccountPets;
    const result = await listPets(params.credentials);
    if (!shouldContinue()) return { status: "cancelled" };

    if (!result.ok) {
        if (result.errorCode === "custom_pet_sync_unavailable") {
            return {
                status: "unavailable",
                reason: "custom_pet_sync_unavailable",
            };
        }
        throw new Error(result.errorCode);
    }

    params.applyAccountPets(result.pets);
    return { status: "applied", count: result.pets.length };
}
