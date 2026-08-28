import {
    buildBackendTargetKey,
    parseQualifiedPluginContributionKey,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    type AccountProfile,
    type ConnectedServiceId,
    type PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    parseConnectedServicesBindingsByServiceIdFromAgentOptionState,
    parseConnectedServicesServiceBinding,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
    resolveQualifiedConnectedAccountServiceKey,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

/**
 * The session quota/recovery corridor's resolved Connected Account binding.
 * `serviceKey` is the canonical qualified identity the resolution decided in;
 * `legacyServiceId` is its exact released scalar projection for the released
 * V2/V3 quota lookups (transport selection, recovery-credit consume wire, V2
 * group facts). Novel external services have no scalar projection and no
 * quota/recovery capability in this corridor — they fail closed upstream and
 * never reach this shape.
 */
export type ConnectedServiceSessionQuotaProfileRef = Readonly<{
    serviceKey: string;
    legacyServiceId: ConnectedServiceId;
    profileId: string;
}>;

function readObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readTrimmedString(value: unknown): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * The supported Connected Account services for the current Session identity,
 * as canonical qualified keys. The exact Agent-owned account declarations from
 * the machine catalog projection are authoritative when available; released
 * bundled catalog facts translate through the provenance-named legacy ingress.
 * Unknown facts fail closed and are dropped.
 */
function resolveSupportedQualifiedServiceKeys(params: Readonly<{
    agentId: string;
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
}>): readonly string[] {
    if (params.connectedAccounts && params.connectedAccounts.length > 0) {
        return resolveProjectedConnectedAccountServiceKeys(params.connectedAccounts);
    }
    if (!isBundledAgentId(params.agentId)) return [];
    const out: string[] = [];
    for (const serviceId of getAgentCore(params.agentId).connectedServices?.supportedServiceIds ?? []) {
        const qualified = resolveQualifiedConnectedAccountServiceKey(serviceId);
        if (qualified && !out.includes(qualified)) out.push(qualified);
    }
    return out;
}

/**
 * Binding-map keys are canonical qualified keys on current writers. Released
 * bundled Sessions persisted scalar keys surface only through the named legacy
 * ingress; unknown keys fail closed and are dropped.
 */
function readQualifiedServiceBindingLookup(
    entries: ReadonlyArray<readonly [string, unknown]>,
): Readonly<Record<string, ConnectedServicesServiceBinding>> {
    const out: Record<string, ConnectedServicesServiceBinding> = {};
    for (const [serviceId, value] of entries) {
        const binding = parseConnectedServicesServiceBinding(value);
        const qualifiedServiceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
        if (!qualifiedServiceKey || !binding) continue;
        out[qualifiedServiceKey] ??= binding;
    }
    return out;
}

function resolveActiveGroupProfileId(params: Readonly<{
    services: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: ConnectedServiceId;
    groupId: string;
}>): string | null {
    const service = params.services.find((candidate) => candidate.serviceId === params.serviceId) ?? null;
    if (!service) return null;

    const group = service.groups.find((candidate) => candidate.groupId === params.groupId) ?? null;
    if (!group) return null;

    // Usage DISPLAY fails OPEN: exclude a member ONLY for an explicit,
    // recognized needs_reauth. Absent/unknown/'' status keeps the member
    // eligible for the session quota badge (single shared predicate).
    const connectedProfileIds = new Set(
        service.profiles
            .filter((profile) => !shouldHideQuotaForCredentialStatus(profile.status))
            .map((profile) => profile.profileId.trim())
            .filter(Boolean),
    );
    if (connectedProfileIds.size === 0) return null;

    const activeProfileId = readTrimmedString(group.activeProfileId);
    if (activeProfileId && connectedProfileIds.has(activeProfileId)) {
        return activeProfileId;
    }

    for (const memberProfileId of group.memberProfileIds) {
        const candidate = memberProfileId.trim();
        if (candidate && connectedProfileIds.has(candidate)) return candidate;
    }

    return null;
}

function resolveBindingProfileId(params: Readonly<{
    optionBinding: ConnectedServicesServiceBinding | undefined;
    payloadBinding: ConnectedServicesServiceBinding | undefined;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
    legacyServiceId: ConnectedServiceId | null;
}>): string | null {
    const explicitProfileId =
        readTrimmedString(params.optionBinding?.profileId)
        ?? readTrimmedString(params.payloadBinding?.profileId);
    if (explicitProfileId) return explicitProfileId;

    const selection = params.optionBinding?.selection ?? params.payloadBinding?.selection;
    if (selection !== 'group') return null;

    const groupId = readTrimmedString(params.optionBinding?.groupId)
        ?? readTrimmedString(params.payloadBinding?.groupId);
    if (!groupId) return null;

    // The V2 account lookup still speaks scalar service ids; convert the
    // already-resolved qualified binding locally and typed. A service without
    // a released scalar projection has no V2 group facts — fail closed.
    if (!params.legacyServiceId) return null;
    return resolveActiveGroupProfileId({
        services: params.accountProfileConnectedServicesV2,
        serviceId: params.legacyServiceId,
        groupId,
    });
}

export function resolveConnectedServiceQuotaProfileRefForSession(params: Readonly<{
    metadata: Metadata | null | undefined;
    agentId: string;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
    /** Exact Agent-owned account declarations from the machine catalog projection, when available. */
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
}>): ConnectedServiceSessionQuotaProfileRef | null {
    const supportedServiceKeys = resolveSupportedQualifiedServiceKeys({
        agentId: params.agentId,
        connectedAccounts: params.connectedAccounts,
    });
    if (supportedServiceKeys.length === 0) return null;

    const metadata = readObjectRecord(params.metadata);
    if (!metadata) return null;

    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.agentId });
    const agentOptionStateByAgentId = readObjectRecord(metadata.agentNewSessionOptionStateByAgentId);
    const agentOptionState =
        readObjectRecord(agentOptionStateByAgentId?.[targetKey])
        ?? readObjectRecord(agentOptionStateByAgentId?.[params.agentId])
        ?? null;
    const optionStateBindings = readQualifiedServiceBindingLookup(
        Object.entries(parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
            agentOptionState,
        })),
    );
    const connectedServicesPayload =
        readObjectRecord(agentOptionState?.connectedServices)
        ?? readObjectRecord(metadata.connectedServices)
        ?? null;
    const payloadBindings = readQualifiedServiceBindingLookup(
        Object.entries(readObjectRecord(connectedServicesPayload?.bindingsByServiceId) ?? {}),
    );

    for (const serviceKey of supportedServiceKeys) {
        const optionBinding = optionStateBindings[serviceKey];
        const payloadBinding = payloadBindings[serviceKey];
        const source = optionBinding?.source ?? (payloadBinding?.source === 'connected' ? 'connected' : payloadBinding?.source === 'native' ? 'native' : null);
        if (source !== 'connected') continue;
        const identity = parseQualifiedPluginContributionKey(serviceKey);
        const legacyServiceId = identity
            ? readBuiltInLegacyConnectedServiceIdForQualifiedService(identity)
            : null;
        // Without a released scalar quota identity the session quota/recovery
        // corridor cannot serve this binding (fail closed).
        if (!legacyServiceId) continue;
        const profileId = resolveBindingProfileId({
            optionBinding,
            payloadBinding,
            accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2,
            legacyServiceId,
        });
        if (!profileId) continue;
        return { serviceKey, legacyServiceId, profileId };
    }

    return null;
}
