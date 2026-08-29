import {
    buildBackendTargetKeyV2,
    resolveActionBackendTargetSelection,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol';
import type { ConnectedServicesProfileOption } from '@happier-dev/agents';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

/**
 * The app client's `sessions.spawn.*` / `agents.*` inventory Action
 * dependencies.
 *
 * Every function here is a projection over incumbent owners — the machine
 * capability probe transport, the Account's Connected Account profile, and the
 * shared V4 → session-options qualifier — so an external qualified Agent is
 * answered by the same facts the New Session screen reads, never by a second
 * inventory or a bundled-catalog fallback.
 *
 * Failure rules: an unknown Agent id or an unprobeable machine produces a typed
 * empty/unavailable answer, never bundled Codex/Claude substitutes.
 */

type AgentInventoryProbeTarget = Readonly<{
    /** The runtime Agent id that names the machine capability (`cli.<id>`). */
    agentId: string;
    /**
     * The V1 backend target carried to the probe, when the target can be
     * expressed in that vocabulary at all. An external qualified Agent target
     * (`agent:<pluginId>/<localId>`) has no V1 carrier form — the daemon
     * resolves it from the capability id — so omitting the param is the
     * contract, not a lost fact.
     */
    backendTargetParam: BackendTargetRefV1 | null;
}>;

export async function resolveSessionSpawnAgentInventorySelectionForActions(args: Readonly<{
    agentTarget: AgentExecutionTargetV1;
    machineId?: string;
    serverId?: string;
}>): Promise<Readonly<{ agentId: string; backendTargetKey: string }> | null> {
    const machineId = normalizeId(args.machineId);
    if (!machineId) return null;
    const serverId = normalizeId(args.serverId) || normalizeId(getActiveServerSnapshot()?.serverId);
    const described = await machineContributionRegistryProjectionDescribe(machineId, {
        ...(serverId ? { serverId } : {}),
    });
    if (!described.supported || described.projection.v !== 2) return null;
    const entry = Object.values(described.projection.agentsById).find((candidate) => (
        candidate.identity?.pluginId === args.agentTarget.identity.pluginId
        && candidate.identity.localId === args.agentTarget.identity.localId
    ));
    if (!entry) return null;
    return {
        agentId: entry.id,
        backendTargetKey: buildBackendTargetKeyV2(args.agentTarget),
    };
}

type AgentInventoryTargetResolution =
    | Readonly<{ ok: true; target: AgentInventoryProbeTarget }>
    | Readonly<{ ok: false; errorCode: 'invalid_parameters' | 'unknown_agent' }>;

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Parses one canonical Agent selection into the machine-probe target.
 *
 * `backend:`-form keys (and identity keys of bundled Agents, which canonicalize
 * to `agent:`) convert through the Protocol owner into a V1 probe target.
 * A novel external identity key has no V1 carrier — it fails closed unless the
 * caller names the runtime Agent id that the machine capability probe needs.
 */
export function resolveAgentInventoryProbeTarget(args: Readonly<{
    agentId?: string | null;
    backendTargetKey?: string | null;
}>): AgentInventoryTargetResolution {
    const providedAgentId = normalizeId(args.agentId);
    const backendTargetKey = normalizeId(args.backendTargetKey);
    const resolved = resolveActionBackendTargetSelection({
        ...(providedAgentId ? { agentId: providedAgentId } : {}),
        ...(backendTargetKey ? { backendTargetKey } : {}),
    });
    if (!resolved.ok) {
        return {
            ok: false,
            errorCode: resolved.path === 'agentId' ? 'unknown_agent' : 'invalid_parameters',
        };
    }
    if (!resolved.selection.agentId) {
        return { ok: false, errorCode: 'unknown_agent' };
    }
    return {
        ok: true,
        target: {
            agentId: resolved.selection.agentId,
            backendTargetParam: resolved.selection.backendTarget,
        },
    };
}

async function probeAgentInventory(
    machineId: string,
    target: AgentInventoryProbeTarget,
    method: 'probeModes' | 'probeConfigOptions',
    requestedServerId?: string,
): Promise<Readonly<{ ok: true; result: Record<string, unknown> }> | Readonly<{ ok: false }>> {
    const serverId = normalizeId(requestedServerId) || normalizeId(getActiveServerSnapshot()?.serverId);
    const res = await machineCapabilitiesInvoke(
        machineId,
        {
            id: buildProviderCliCapabilityId(target.agentId),
            method,
            params: {
                timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                ...(target.backendTargetParam ? { backendTarget: target.backendTargetParam } : {}),
            },
        },
        { ...(serverId ? { serverId } : {}) },
    );
    if (!res.supported || !res.response.ok) return { ok: false };
    const result = res.response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false };
    return { ok: true, result: result as Record<string, unknown> };
}

function readProbeSource(result: Record<string, unknown>): 'static' | 'dynamic' | 'unavailable' | null {
    const source = result.source;
    return source === 'static' || source === 'dynamic' || source === 'unavailable'
        ? source
        : null;
}

function inventoryListResult(params: Readonly<{
    agentId: string;
    items: readonly unknown[];
    source: 'static' | 'dynamic' | 'unavailable';
    limit: number | null;
}>): unknown {
    const bounded = params.limit ? params.items.slice(0, params.limit) : params.items;
    return {
        agentId: params.agentId,
        items: bounded,
        source: params.source,
    };
}

function readInventoryLimit(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.min(200, Math.floor(raw)));
}

function dedupeById(items: readonly Readonly<{ id: string }>[]): readonly Readonly<{ id: string }>[] {
    return items.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
}

export type AgentSessionModesListArgs = Readonly<{
    agentId?: string;
    machineId?: string;
    serverId?: string;
    limit?: number;
    backendTargetKey?: string;
}>;

/**
 * `agents.session_modes.list`: the selected machine's mode probe, projected
 * into the shared inventory row shape the CLI host answers with.
 */
export async function listAgentSessionModesForActions(args: AgentSessionModesListArgs): Promise<unknown> {
    const target = resolveAgentInventoryProbeTarget(args);
    if (!target.ok) {
        return { ok: false, errorCode: target.errorCode, errorMessage: target.errorCode };
    }
    const machineId = normalizeId(args.machineId);
    if (!machineId) {
        // Session modes are a machine fact; without a machine there is no
        // honest answer and no bundled stand-in.
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
    const probe = await probeAgentInventory(machineId, target.target, 'probeModes', args.serverId);
    if (!probe.ok) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
        });
    }
    const source = readProbeSource(probe.result);
    const modesRaw = probe.result.availableModes;
    if (!source || !Array.isArray(modesRaw)) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
        });
    }
    const items = dedupeById(modesRaw
        .map((entry: unknown): Readonly<{ id: string; label: string; description?: string }> | null => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const record = entry as Record<string, unknown>;
            const id = normalizeId(record.id);
            if (!id) return null;
            const name = normalizeId(record.name);
            const description = normalizeId(record.description);
            return {
                id,
                label: name || id,
                ...(description ? { description } : {}),
            };
        })
        .filter((entry): entry is Readonly<{ id: string; label: string; description?: string }> => entry !== null));
    return inventoryListResult({
        agentId: target.target.agentId,
        items,
        source,
        limit: readInventoryLimit(args.limit),
    });
}

export type AgentConfigOptionsListArgs = Readonly<{
    agentId?: string;
    machineId?: string;
    serverId?: string;
    limit?: number;
    backendTargetKey?: string;
    modelId?: string;
}>;

/**
 * `agents.config_options.list`: the selected machine's config-option probe,
 * projected into the shared inventory row shape the CLI host answers with.
 */
export async function listAgentConfigOptionsForActions(args: AgentConfigOptionsListArgs): Promise<unknown> {
    const target = resolveAgentInventoryProbeTarget(args);
    if (!target.ok) {
        return { ok: false, errorCode: target.errorCode, errorMessage: target.errorCode };
    }
    const machineId = normalizeId(args.machineId);
    if (!machineId) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
    const probe = await probeAgentInventory(machineId, target.target, 'probeConfigOptions', args.serverId);
    if (!probe.ok) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
        });
    }
    const source = readProbeSource(probe.result);
    const optionsRaw = probe.result.configOptions;
    if (!source || !Array.isArray(optionsRaw)) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
        });
    }
    const items = dedupeById(optionsRaw
        .map((entry: unknown): Readonly<{
            id: string;
            label: string;
            type: string;
            description?: string;
            options?: readonly Readonly<{ value: unknown; label: string; description?: string }>[];
        }> | null => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const record = entry as Record<string, unknown>;
            const id = normalizeId(record.id);
            if (!id) return null;
            const name = normalizeId(record.name);
            const type = normalizeId(record.type) || 'unknown';
            const description = normalizeId(record.description);
            const choices = Array.isArray(record.options)
                ? record.options
                    .map((choice: unknown): Readonly<{ value: unknown; label: string; description?: string }> | null => {
                        if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return null;
                        const choiceRecord = choice as Record<string, unknown>;
                        const choiceLabel = normalizeId(choiceRecord.name);
                        if (!choiceLabel) return null;
                        const choiceDescription = normalizeId(choiceRecord.description);
                        return {
                            value: choiceRecord.value,
                            label: choiceLabel,
                            ...(choiceDescription ? { description: choiceDescription } : {}),
                        };
                    })
                    .filter((choice): choice is Readonly<{ value: unknown; label: string; description?: string }> => choice !== null)
                : [];
            return {
                id,
                label: name || id,
                type,
                ...(description ? { description } : {}),
                ...(choices.length > 0 ? { options: choices } : {}),
            };
        })
        .filter((entry): entry is Readonly<{
            id: string;
            label: string;
            type: string;
            description?: string;
            options?: readonly Readonly<{ value: unknown; label: string; description?: string }>[];
        }> => entry !== null));
    return inventoryListResult({
        agentId: target.target.agentId,
        items,
        source,
        limit: readInventoryLimit(args.limit),
    });
}

export type SpawnConnectedServicesListArgs = Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    machineId?: string;
    serverId?: string;
    includeUnavailable?: boolean;
}>;

/**
 * `sessions.spawn.connected_services.list`: the Account's Connected Accounts,
 * qualified through the one V4 → session-options projection every Session
 * connected-account surface shares.
 *
 * A bundled Agent contributes its declared supported-service set (resolved to
 * canonical qualified keys); an external qualified Agent's set is open, so the
 * Account's own connected services are the supported facts. Unknown services
 * and disconnected profiles never invent rows, and no bundled Codex/Claude
 * declaration is ever substituted for an external Agent.
 */
export async function listSpawnConnectedServicesForActions(args: SpawnConnectedServicesListArgs): Promise<unknown> {
    const agentId = normalizeId(args.agentId);
    if (!agentId) {
        return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent' };
    }
    const state = storage.getState();
    const connectedAccounts = state.profile?.connectedAccountsV4 ?? [];
    const connectedGroups = state.profile?.connectedAccountGroupsV4 ?? [];

    const agentCore = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
    let projectedConnectedAccounts: readonly Readonly<{
        service: { pluginId: string; localId: string };
        credentialKinds?: readonly ('oauth' | 'token')[];
    }>[] = [];
    const machineId = normalizeId(args.machineId);
    if (machineId) {
        const serverId = normalizeId(args.serverId) || normalizeId(getActiveServerSnapshot()?.serverId);
        const described = await machineContributionRegistryProjectionDescribe(machineId, {
            ...(serverId ? { serverId } : {}),
        });
        if (described.supported && described.projection.v === 2) {
            projectedConnectedAccounts = described.projection.agentsById[agentId]?.connectedAccounts ?? [];
        }
    }
    const supportedServiceIds = projectedConnectedAccounts.length > 0
        ? resolveProjectedConnectedAccountServiceKeys(projectedConnectedAccounts)
        : agentCore
        ? (agentCore.connectedServices?.supportedServiceIds ?? [])
            .map((serviceId) => resolveQualifiedConnectedAccountServiceKey(serviceId))
            .filter((serviceKey): serviceKey is string => Boolean(serviceKey))
            .filter((serviceKey, index, all) => all.indexOf(serviceKey) === index)
        : [];

    if (supportedServiceIds.length === 0) {
        return { agentId, supportedServiceIds: [], items: [] };
    }

    const labelsByKey = readConnectedServiceProfileLabels(state.settings);
    const profileOptionsByServiceId = applyProjectedCredentialKindRestrictions({
        optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: connectedAccounts,
            supportedServiceIds,
            labelsByKey,
        }),
        connectedAccounts: projectedConnectedAccounts,
    });
    const groupOptionsByServiceId = buildQualifiedConnectedAccountGroupOptionsByServiceId({
        groups: connectedGroups,
        supportedServiceIds,
    });

    const includeUnavailable = args.includeUnavailable === true;
    const items = Object.entries(profileOptionsByServiceId).flatMap(([serviceId, options]) => (
        options
            .filter((option) => includeUnavailable || option.status === 'connected')
            .map((option) => ({
                value: `${serviceId}:profile:${option.profileId}`,
                label: option.label ?? option.providerEmail ?? `${serviceId}:${option.profileId}`,
            }))
    ));

    return {
        agentId,
        supportedServiceIds,
        profileOptionsByServiceId,
        groupOptionsByServiceId,
        items,
    };
}

function readConnectedServiceProfileLabels(settings: unknown): Record<string, string | undefined> {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
    const labels = (settings as Record<string, unknown>).connectedServicesProfileLabelByKey;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
    return labels as Record<string, string | undefined>;
}
