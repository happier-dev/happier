import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { listAccountPets } from "@/sync/api/pets/apiAccountPets";
import { resolveRuntimeFeatureDecisionOrThrow } from "@/sync/domains/features/featureDecisionInputs";
import type { ServerFetch } from "@/sync/http/client";

import type {
    AccountPetMetadata,
    AccountPetLibraryStatus,
} from "./accountPetLibraryTypes";

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
    /** Captured Sync transport for the applied Home; never resolve staged selection here. */
    request?: ServerFetch;
    resolvePetsSyncEnabled?: (params: AccountPetsSyncDecisionParams) => Promise<boolean>;
    applyAccountPets: (pets: AccountPetMetadata[]) => void;
    setAccountPetsStatus?: (status: Exclude<AccountPetLibraryStatus, 'pending'>) => void;
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
    const decision = await resolveRuntimeFeatureDecisionOrThrow({
        featureId: "pets.sync",
        ...params,
    });
    return decision.state === "enabled";
}

async function fetchAndApplyAccountPetsInternal(
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

    // The list owner decides Account mode, opens E2EE entries and reports unavailable admission.
    const result = params.request
        ? await listAccountPets(params.credentials, { request: params.request })
        : await listAccountPets(params.credentials);
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

/** Publish settling status from the same read that owns the library contents. */
export async function fetchAndApplyAccountPets(params: FetchAndApplyAccountPetsParams): Promise<FetchAndApplyAccountPetsResult> {
    try {
        const result = await fetchAndApplyAccountPetsInternal(params);
        if (result.status !== 'cancelled') {
            params.setAccountPetsStatus?.(result.status === 'unavailable' ? 'unavailable' : 'ready');
        }
        return result;
    } catch (error) {
        if (params.shouldContinue?.() !== false) params.setAccountPetsStatus?.('unavailable');
        throw error;
    }
}
