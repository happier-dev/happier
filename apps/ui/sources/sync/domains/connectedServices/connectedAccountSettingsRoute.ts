import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    buildQualifiedPluginContributionKey,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceIdSchema,
    PluginContributionIdentityV1Schema,
    QualifiedConnectedAccountIdSchema,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type {
    ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';

export const CONNECTED_ACCOUNT_SETTINGS_ROUTE =
    '/(app)/settings/connected-services/account' as const;

export type ConnectedAccountSettingsRouteFocus =
    | Readonly<{ kind: 'account'; accountId: string }>
    | Readonly<{ kind: 'group'; groupId: string }>;

export type ConnectedAccountSettingsRouteExecutionTarget = Readonly<{
    serverId: string;
    machineId: string;
}>;

export type ConnectedAccountSettingsRouteResolution = Readonly<{
    service: PluginContributionIdentityV1;
    entry: ConnectedServiceRegistryEntry;
    legacyServiceId: ConnectedServiceId | null;
    focus: ConnectedAccountSettingsRouteFocus | null;
    executionTarget?: ConnectedAccountSettingsRouteExecutionTarget;
}>;

function readSingleRouteParam(value: unknown): string | null {
    if (Array.isArray(value)) {
        return value.length === 1 ? readSingleRouteParam(value[0]) : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function findExactEntry(
    entries: readonly ConnectedServiceRegistryEntry[],
    service: PluginContributionIdentityV1,
): ConnectedServiceRegistryEntry | null {
    const qualifiedKey = buildQualifiedPluginContributionKey(service);
    return entries.find((entry) => {
        if (!entry.service) return false;
        const parsed = PluginContributionIdentityV1Schema.safeParse(entry.service);
        return parsed.success
            && buildQualifiedPluginContributionKey(parsed.data) === qualifiedKey;
    }) ?? null;
}

function resolveMatchingLegacyServiceId(
    entry: ConnectedServiceRegistryEntry,
    service: PluginContributionIdentityV1,
): ConnectedServiceId | null {
    const legacyServiceId = ConnectedServiceIdSchema.safeParse(entry.serviceId);
    if (!legacyServiceId.success) return null;
    const expected =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            legacyServiceId.data
        ].service;
    return expected.pluginId === service.pluginId
        && expected.localId === service.localId
        ? legacyServiceId.data
        : null;
}

function resolveRouteFocus(params: Readonly<{
    accountId?: unknown;
    groupId?: unknown;
}>): Readonly<{
    valid: boolean;
    focus: ConnectedAccountSettingsRouteFocus | null;
}> {
    const accountPresent = params.accountId !== undefined;
    const groupPresent = params.groupId !== undefined;
    if (accountPresent && groupPresent) {
        return { valid: false, focus: null };
    }
    if (accountPresent) {
        const rawAccountId = readSingleRouteParam(params.accountId);
        const accountId = QualifiedConnectedAccountIdSchema.safeParse(rawAccountId);
        return accountId.success
            ? { valid: true, focus: { kind: 'account', accountId: accountId.data } }
            : { valid: false, focus: null };
    }
    if (groupPresent) {
        const rawGroupId = readSingleRouteParam(params.groupId);
        const groupId = ConnectedServiceAuthGroupIdSchema.safeParse(rawGroupId);
        return groupId.success
            ? { valid: true, focus: { kind: 'group', groupId: groupId.data } }
            : { valid: false, focus: null };
    }
    return { valid: true, focus: null };
}

function resolveRouteExecutionTarget(params: Readonly<{
    serverId?: unknown;
    machineId?: unknown;
}>): Readonly<{
    valid: boolean;
    executionTarget: ConnectedAccountSettingsRouteExecutionTarget | null;
}> {
    const serverPresent = params.serverId !== undefined;
    const machinePresent = params.machineId !== undefined;
    if (!serverPresent && !machinePresent) {
        return { valid: true, executionTarget: null };
    }
    if (!serverPresent || !machinePresent) {
        return { valid: false, executionTarget: null };
    }
    const serverId = readSingleRouteParam(params.serverId);
    const machineId = readSingleRouteParam(params.machineId);
    if (
        serverId === null
        || machineId === null
        || serverId.length > 256
        || machineId.length > 256
    ) {
        return { valid: false, executionTarget: null };
    }
    return {
        valid: true,
        executionTarget: { serverId, machineId },
    };
}

export function buildConnectedAccountSettingsRoute(
    service: PluginContributionIdentityV1,
    focus: ConnectedAccountSettingsRouteFocus | null = null,
    executionTarget: ConnectedAccountSettingsRouteExecutionTarget | null = null,
) {
    const parsed = PluginContributionIdentityV1Schema.parse(service);
    const parsedFocus = focus === null
        ? null
        : focus.kind === 'account'
            ? {
                kind: 'account' as const,
                accountId: QualifiedConnectedAccountIdSchema.parse(focus.accountId),
            }
            : {
                kind: 'group' as const,
                groupId: ConnectedServiceAuthGroupIdSchema.parse(focus.groupId),
            };
    const parsedExecutionTarget = executionTarget === null
        ? null
        : resolveRouteExecutionTarget(executionTarget).executionTarget;
    if (executionTarget !== null && parsedExecutionTarget === null) {
        throw new Error('Invalid connected account settings execution target');
    }
    return {
        pathname: CONNECTED_ACCOUNT_SETTINGS_ROUTE,
        params: {
            pluginId: parsed.pluginId,
            localId: parsed.localId,
            ...(parsedFocus?.kind === 'account'
                ? { accountId: parsedFocus.accountId }
                : {}),
            ...(parsedFocus?.kind === 'group'
                ? { groupId: parsedFocus.groupId }
                : {}),
            ...(parsedExecutionTarget
                ? {
                    serverId: parsedExecutionTarget.serverId,
                    machineId: parsedExecutionTarget.machineId,
                }
                : {}),
        },
    } as const;
}

export function resolveQualifiedConnectedAccountSettingsRoute(
    params: Readonly<{
        pluginId?: unknown;
        localId?: unknown;
        serviceId?: unknown;
        accountId?: unknown;
        profileId?: unknown;
        groupId?: unknown;
        serverId?: unknown;
        machineId?: unknown;
    }>,
    entries: readonly ConnectedServiceRegistryEntry[],
): ConnectedAccountSettingsRouteResolution | null {
    const pluginId = readSingleRouteParam(params.pluginId);
    const localId = readSingleRouteParam(params.localId);
    const focus = resolveRouteFocus({
        accountId: params.accountId,
        groupId: params.groupId,
    });
    const executionTarget = resolveRouteExecutionTarget({
        serverId: params.serverId,
        machineId: params.machineId,
    });
    if (
        pluginId === null
        || localId === null
        || params.serviceId !== undefined
        || params.profileId !== undefined
        || !focus.valid
        || !executionTarget.valid
    ) {
        return null;
    }
    const parsed = PluginContributionIdentityV1Schema.safeParse({
        pluginId,
        localId,
    });
    if (!parsed.success) return null;
    const entry = findExactEntry(entries, parsed.data);
    if (!entry || entry.executable === false) return null;
    return {
        service: parsed.data,
        entry,
        legacyServiceId: resolveMatchingLegacyServiceId(entry, parsed.data),
        focus: focus.focus,
        ...(executionTarget.executionTarget
            ? { executionTarget: executionTarget.executionTarget }
            : {}),
    };
}

/**
 * Reads the canonical qualified route, with one compatibility ingress for old
 * built-in `/connected-services/[serviceId]` links. The legacy scalar is
 * translated to the daemon-projected qualified owner before any account
 * operation; it never becomes authority for an external service.
 */
export function resolveConnectedAccountSettingsRoute(
    params: Readonly<{
        pluginId?: unknown;
        localId?: unknown;
        serviceId?: unknown;
        accountId?: unknown;
        profileId?: unknown;
        groupId?: unknown;
        serverId?: unknown;
        machineId?: unknown;
    }>,
    entries: readonly ConnectedServiceRegistryEntry[],
): ConnectedAccountSettingsRouteResolution | null {
    const rawLegacyServiceId = readSingleRouteParam(params.serviceId);

    if (params.pluginId !== undefined || params.localId !== undefined) {
        return resolveQualifiedConnectedAccountSettingsRoute(params, entries);
    }

    const legacyServiceId = ConnectedServiceIdSchema.safeParse(rawLegacyServiceId);
    const focus = resolveRouteFocus({
        accountId: params.profileId,
        groupId: params.groupId,
    });
    if (
        !legacyServiceId.success
        || params.accountId !== undefined
        || params.serverId !== undefined
        || params.machineId !== undefined
        || !focus.valid
    ) return null;
    const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            legacyServiceId.data
        ];
    const service = PluginContributionIdentityV1Schema.safeParse(
        compatibility.service,
    );
    if (!service.success) return null;
    const entry = findExactEntry(entries, service.data);
    if (
        !entry
        || entry.serviceId !== legacyServiceId.data
        || entry.executable === false
    ) {
        return null;
    }
    return {
        service: service.data,
        entry,
        legacyServiceId: legacyServiceId.data,
        focus: focus.focus,
    };
}

export function resolveConnectedAccountOperationTarget(params: Readonly<{
    activeServerId: unknown;
    executionTarget: ConnectedAccountSettingsRouteExecutionTarget | null;
    machines: readonly Readonly<{
        id: string;
        active?: boolean | null;
    }>[];
}>): ConnectedAccountSettingsRouteExecutionTarget | null {
    const activeServerId = readSingleRouteParam(params.activeServerId);
    if (activeServerId === null) return null;
    if (params.executionTarget) {
        const requestedMachineId = params.executionTarget.machineId;
        const exactMachine = params.machines.find(
            (candidate) => (
                candidate.id === requestedMachineId
                && candidate.active === true
            ),
        );
        return exactMachine
            ? {
                serverId: params.executionTarget.serverId,
                machineId: exactMachine.id,
            }
            : null;
    }
    const defaultMachine = params.machines.find(
        (candidate) => candidate.active === true,
    ) ?? params.machines[0] ?? null;
    return defaultMachine
        ? {
            serverId: activeServerId,
            machineId: defaultMachine.id,
        }
        : null;
}
