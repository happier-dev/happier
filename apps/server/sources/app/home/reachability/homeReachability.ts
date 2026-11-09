import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig, type ServerConfigEnv } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { type HomeIrohModeV1, type HomeReachabilityV1 } from '@happier-dev/protocol/home/governance';
import { getRelayAccessProviderDescriptor } from "@happier-dev/cli-common/relayAccess";

import { readHomeConnectionDescriptor } from "@/app/features/homeConnectionDescriptorPublication";
import { publishHomeGovernanceChangedInTx } from "@/app/home/governance/governanceChanges";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { readHomeConfigValueSource } from "@/app/home/settings/homeConfigProvenance";
import {
    HomeSettingsMutationAbortError,
    REACHABILITY_ROUTED_SETTING_KEYS,
    readHomeSettingsInTx,
    setHomeSettingsInTx,
} from "@/app/home/settings/homeSettings";
import type { InferredPublicServerAccess } from "@/app/integrations/publicUrl/publicServerUrlInference";
import {
    getHomeIrohEndpointState,
    readHomeIrohComposition,
    resumeHomeIrohEndpoint,
    retireHomeIrohEndpoint,
    type HomeIrohEndpointState,
} from "@/app/iroh/homeIrohEndpoint";
import {
    DEFAULT_WEBAPP_URL,
    resolveConfiguredPublicServerUrl,
    resolveDerivedLocalUiWebappUrl,
    resolveExplicitWebappUrl,
} from "@/app/serverUrls/effectiveServerUrls";
import { log } from "@/utils/logging/log";
import { inTx } from "@/storage/inTx";

/**
 * How this Home is reached (plan `2026-09-26-home-owner-console` §3.2, decision B, AM-2).
 *
 * This owner only projects and sequences; every decision stays with its owner: the configuration
 * overlay decides the address precedence (deployment env → stored Home value → inferred → none),
 * the inference owner says what the hosting computer reports, the Iroh endpoint owner runs the
 * lifecycle, and the descriptor publisher alone publishes what devices dial.
 */

const IROH_MODE_KEY = SERVER_CONFIG.HAPPIER_HOME_IROH_MODE.key;

function projectPublicAddress(env: ServerConfigEnv, access: InferredPublicServerAccess | null): HomeReachabilityV1["publicAddress"] {
    const url = resolveConfiguredPublicServerUrl(env) ?? null;
    const source = url ? readHomeConfigValueSource(env, SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key) ?? "deployment" : "none";
    if (source !== "inferred") return { url, source };
    const inferredFrom = access?.inferred?.source;
    return inferredFrom ? { url, source, inferredFrom } : { url, source };
}

function projectWebApp(env: ServerConfigEnv): HomeReachabilityV1["webApp"] {
    const explicit = resolveExplicitWebappUrl(env);
    if (explicit) {
        // An alias-only value (`HAPPY_WEBAPP_URL`) is the deployment's own.
        const source = readHomeConfigValueSource(env, SERVER_CONFIG.HAPPIER_WEBAPP_URL.key) === "home" ? "home" : "deployment";
        return { url: explicit, source };
    }
    const served = resolveDerivedLocalUiWebappUrl(env);
    if (served) return { url: served, source: "public_address" };
    return { url: DEFAULT_WEBAPP_URL, source: "default" };
}

function projectIrohState(state: HomeIrohEndpointState): HomeReachabilityV1["iroh"]["state"] {
    return state.status === "not-composed" ? "not_composed" : state.status;
}

export function projectHomeReachability(params: Readonly<{
    /** The live configuration overlay (deployment env, stored Home values, inferred address). */
    env: ServerConfigEnv;
    access: InferredPublicServerAccess | null;
    iroh: HomeIrohEndpointState;
    irohAvailable: boolean;
}>): HomeReachabilityV1 {
    const relayAccess = params.access?.relayAccess ?? null;
    // Observed native status is a projection of the static pre-plugin Home catalog.
    const method = relayAccess ? getRelayAccessProviderDescriptor({ kind: 'builtin', id: relayAccess.providerId }).definition.homeAccessMethod : undefined;
    return {
        publicAddress: projectPublicAddress(params.env, params.access),
        webApp: projectWebApp(params.env),
        hostAccess: relayAccess && method
            ? { method, exposure: relayAccess.exposure, shareUrl: relayAccess.shareUrl }
            : null,
        iroh: {
            availability: params.irohAvailable ? "available" : "not_available",
            mode: readServerConfig(params.env, SERVER_CONFIG.HAPPIER_HOME_IROH_MODE) === "disabled" ? "disabled" : "enabled",
            modeFixed: readHomeConfigValueSource(params.env, IROH_MODE_KEY) === "deployment",
            state: projectIrohState(params.iroh),
            endpointId: params.iroh.snapshot?.endpoint.endpointId ?? null,
            failureReason: params.iroh.failureReason,
        },
    };
}

export async function readHomeReachability(params: Readonly<{
    env: ServerConfigEnv;
    access: InferredPublicServerAccess | null;
}>): Promise<HomeReachabilityV1> {
    return projectHomeReachability({
        env: params.env,
        access: params.access,
        iroh: await getHomeIrohEndpointState(),
        irohAvailable: readHomeIrohComposition() !== null,
    });
}

export type HomeIrohModeSetResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "forbidden" }>
    | Readonly<{ status: "not_available" }>
    | Readonly<{ status: "needs_public_address" }>
    | Readonly<{ status: "revision_conflict" }>;

function hasHttpsPublicAddress(env: ServerConfigEnv): boolean {
    const url = resolveConfiguredPublicServerUrl(env);
    return url !== undefined && url.startsWith("https://");
}

/**
 * `home.reachability.iroh.set` (owners, `manageHomeSettings`). Stores the mode (audited as a
 * settings change) and then runs the matching Iroh transition and publishes it:
 * - off: the endpoint stops, its identity is retired for good, and the descriptor publishes the
 *   remaining endpoint set. Refused without an HTTPS public address, because a descriptor with no
 *   endpoint cannot be published and devices would keep dialing the retired identity;
 * - on: a new endpoint identity is created and published.
 * The mode is the source of truth at every start (`startServer`), so a transition that fails
 * midway is completed by the next start rather than left half-applied.
 */
export async function setHomeIrohMode(params: Readonly<{
    actorAccountId: string;
    mode: HomeIrohModeV1;
    /** The live configuration overlay of the request. */
    env: ServerConfigEnv;
}>): Promise<HomeIrohModeSetResult> {
    const composition = readHomeIrohComposition();
    const written = await inTx(async (tx) => {
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: params.actorAccountId,
            request: { operation: "manage_home_settings" },
        });
        if (authorization.status === "rejected") return { status: "forbidden" } as const;
        if (!composition || readHomeConfigValueSource(params.env, IROH_MODE_KEY) === "deployment") {
            return { status: "not_available" } as const;
        }
        if (params.mode === "disabled" && !hasHttpsPublicAddress(params.env)) return { status: "needs_public_address" } as const;
        const current = await readHomeSettingsInTx(tx);
        const result = await setHomeSettingsInTx(tx, {
            actorAccountId: params.actorAccountId,
            write: { expectedRevision: current.revision, values: { [IROH_MODE_KEY]: params.mode } },
            routedKeys: REACHABILITY_ROUTED_SETTING_KEYS,
        });
        switch (result.status) {
            case "applied":
                await publishHomeGovernanceChangedInTx(tx);
                return { status: "applied" } as const;
            case "forbidden":
                return { status: "forbidden" } as const;
            case "revision_conflict":
                return { status: "revision_conflict" } as const;
            case "invalid":
                // The mode is a registry enum validated by the input schema; an invalid write here
                // means the registry entry changed underneath this owner.
                throw new Error(`Home Iroh mode write refused: ${result.reason}`);
            case "invalid_input":
                // This owner never asks for a discard.
                throw new Error("Home Iroh mode write refused: invalid_input");
        }
    }, { isolationLevel: "ReadCommitted" }).catch((error: unknown) => {
        if (error instanceof HomeSettingsMutationAbortError) return { status: error.status };
        throw error;
    });
    if (written.status !== "applied" || !composition) return written;

    const state = params.mode === "disabled" ? await retireHomeIrohEndpoint() : await resumeHomeIrohEndpoint();
    log({ module: "iroh", status: state.status, reason: state.failureReason ?? undefined }, `Home direct connections turned ${params.mode === "disabled" ? "off" : "on"} by the owner`);
    await readHomeConnectionDescriptor({
        env: params.env,
        continuityStore: composition.continuityStore,
        visibility: "authenticated",
    });
    return written;
}
