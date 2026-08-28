import {
    buildQualifiedPluginContributionKey,
    parseQualifiedPluginContributionKey,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    type ConnectedAccountServiceKey,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';
import {
    isConnectedServiceProfileKindSupportedForAgent,
    type AgentCore,
    type ConnectedServicesAccountGroupOption,
    type ConnectedServicesProfileOption,
} from '@happier-dev/agents';

import { connectedServiceProfileKey } from './connectedServiceProfilePreferences';

/**
 * The one V4 → session-options projection shared by every Session
 * connected-account selection surface (new-session composer and the
 * existing-session auth switch). Keys are canonical qualified service keys
 * built from the exact `ref.service` / declaration identity, so an external
 * plugin service flows through with the same shape as a bundled one and no
 * caller can reintroduce a scalar enum key.
 */

export function resolveProjectedConnectedAccountServiceKeys(
    connectedAccounts: ReadonlyArray<Readonly<{ service: { pluginId: string; localId: string } }>>,
): ReadonlyArray<ConnectedAccountServiceKey> {
    const result: ConnectedAccountServiceKey[] = [];
    for (const declaration of connectedAccounts) {
        const serviceKey = buildQualifiedPluginContributionKey(declaration.service);
        if (!result.includes(serviceKey)) result.push(serviceKey);
    }
    return result;
}

function readAccountLabel(params: Readonly<{
    account: QualifiedConnectedAccountProfileV4;
    serviceKey: string;
    labelsByKey: Record<string, string | undefined>;
}>): string | null {
    const displayName = (params.account.displayName ?? '').trim();
    if (displayName) return displayName;
    const storedLabel = params.labelsByKey[
        connectedServiceProfileKey({ serviceId: params.serviceKey, profileId: params.account.ref.accountId })
    ];
    if (typeof storedLabel === 'string' && storedLabel.trim()) return storedLabel.trim();
    return null;
}

export function buildQualifiedConnectedAccountProfileOptionsByServiceId(params: Readonly<{
    accounts: ReadonlyArray<QualifiedConnectedAccountProfileV4>;
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
    labelsByKey: Record<string, string | undefined>;
}>): Readonly<Record<string, ConnectedServicesProfileOption[]>> {
    const supported = new Set<string>(params.supportedServiceIds);
    const options: Record<string, ConnectedServicesProfileOption[]> = {};
    for (const account of params.accounts) {
        const serviceKey = buildQualifiedPluginContributionKey(account.ref.service);
        if (!supported.has(serviceKey)) continue;
        (options[serviceKey] ??= []).push({
            profileId: account.ref.accountId,
            status: account.status,
            kind: account.kind ?? null,
            providerEmail: account.providerIdentity?.email ?? null,
            label: readAccountLabel({ account, serviceKey, labelsByKey: params.labelsByKey }),
        });
    }
    return options;
}

export function buildQualifiedConnectedAccountGroupOptionsByServiceId(params: Readonly<{
    groups: ReadonlyArray<QualifiedConnectedAccountGroupV4>;
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
}>): Readonly<Record<string, ConnectedServicesAccountGroupOption[]>> {
    const supported = new Set<string>(params.supportedServiceIds);
    const options: Record<string, ConnectedServicesAccountGroupOption[]> = {};
    for (const group of params.groups) {
        const serviceKey = buildQualifiedPluginContributionKey(group.ref.service);
        if (!supported.has(serviceKey)) continue;
        const memberProfileIds = group.members
            .filter((member) => member.enabled)
            .map((member) => member.connectedAccountId);
        const activeProfileId = group.activeConnectedAccountId ?? null;
        options[serviceKey] = [
            ...(options[serviceKey] ?? []),
            {
                groupId: group.ref.groupId,
                label: group.displayName ?? group.ref.groupId,
                activeProfileId,
                memberProfileIds,
                generation: group.generation,
                enabledMemberCount: memberProfileIds.length,
                autoSwitch: group.policy.autoSwitch === true,
                status: memberProfileIds.length === 0
                    ? 'needs_members'
                    : activeProfileId
                        ? 'ready'
                        : 'exhausted',
            },
        ];
    }
    return options;
}

/**
 * Applies released bundled Agents' exact per-service credential-kind
 * restrictions to qualified options — the single bundled/external parity
 * overlay for every session connected-account selection surface.
 *
 * The bundled scalar service id is resolved through the canonical generated
 * built-in identity mapping (never the live projection registry, whose
 * loading/retired snapshots must not gate a bundled catalog fact). A service
 * without a generated legacy member — any novel external plugin service —
 * carries no bundled kind restriction and flows through unrestricted, exactly
 * like a bundled service whose Agent declares none.
 */
export function applyAgentKindRestrictionsToQualifiedProfileOptions(params: Readonly<{
    optionsByServiceId: Readonly<Record<string, ConnectedServicesProfileOption[]>>;
    agentCore: Pick<AgentCore, 'connectedServices'> | null | undefined;
}>): Readonly<Record<string, ConnectedServicesProfileOption[]>> {
    const out: Record<string, ConnectedServicesProfileOption[]> = {};
    for (const [serviceKey, serviceOptions] of Object.entries(params.optionsByServiceId)) {
        const identity = parseQualifiedPluginContributionKey(serviceKey);
        const legacyServiceId = identity
            ? readBuiltInLegacyConnectedServiceIdForQualifiedService(identity)
            : null;
        out[serviceKey] = legacyServiceId
            ? serviceOptions.map((option) => {
                const kindSupported = isConnectedServiceProfileKindSupportedForAgent({
                    agentCore: params.agentCore ?? null,
                    serviceId: legacyServiceId,
                    kind: option.kind ?? null,
                });
                return kindSupported ? option : { ...option, status: 'unsupported_kind' as const };
            })
            : serviceOptions;
    }
    return out;
}
