import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    buildQualifiedPluginContributionKey,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceIdSchema,
    parseQualifiedPluginContributionKey,
    PluginContributionIdentityV1Schema,
    QualifiedConnectedAccountIdSchema,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import {
    getGeneratedLegacyConnectedServiceRegistryFallback,
    type ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';

export const CONNECTED_ACCOUNT_SETTINGS_ROUTE =
    '/(app)/settings/connected-services/account' as const;

export type ConnectedAccountSettingsRouteFocus =
    | Readonly<{ kind: 'account'; accountId: string }>
    | Readonly<{ kind: 'group'; groupId: string }>;

export type ConnectedAccountSettingsRouteResolution = Readonly<{
    service: PluginContributionIdentityV1;
    entry: ConnectedServiceRegistryEntry;
    legacyServiceId: ConnectedServiceId | null;
    focus: ConnectedAccountSettingsRouteFocus | null;
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

function resolvePublishedServiceEntry(
    entries: readonly ConnectedServiceRegistryEntry[],
    service: PluginContributionIdentityV1,
): ConnectedServiceRegistryEntry | null {
    const projectedEntry = findExactEntry(entries, service);
    if (projectedEntry) {
        return projectedEntry.executable === false ? null : projectedEntry;
    }
    return getGeneratedLegacyConnectedServiceRegistryFallback(service);
}

function resolveMatchingLegacyServiceId(
    entry: ConnectedServiceRegistryEntry,
    service: PluginContributionIdentityV1,
): ConnectedServiceId | null {
    const legacyServiceId = ConnectedServiceIdSchema.safeParse(entry.legacyServiceId);
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

export function buildConnectedAccountSettingsRoute(
    service: PluginContributionIdentityV1,
    focus: ConnectedAccountSettingsRouteFocus | null = null,
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
    if (
        pluginId === null
        || localId === null
        || params.serviceId !== undefined
        || params.profileId !== undefined
        || !focus.valid
        || params.serverId !== undefined
        || params.machineId !== undefined
    ) {
        return null;
    }
    const parsed = PluginContributionIdentityV1Schema.safeParse({
        pluginId,
        localId,
    });
    if (!parsed.success) return null;
    const entry = resolvePublishedServiceEntry(entries, parsed.data);
    if (!entry) return null;
    return {
        service: parsed.data,
        entry,
        legacyServiceId: resolveMatchingLegacyServiceId(entry, parsed.data),
        focus: focus.focus,
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

    // Canonical current shape first: a qualified Connected Account service key
    // delegates to the exact qualified owner. `profileId` is the legacy-ingress
    // spelling of the qualified `accountId` focus, so recovery callers keep one
    // contract across both service-key shapes; mixing the two focus spellings
    // still fails closed.
    const qualifiedService = rawLegacyServiceId === null
        ? null
        : parseQualifiedPluginContributionKey(rawLegacyServiceId);
    if (qualifiedService) {
        if (params.accountId !== undefined && params.profileId !== undefined) return null;
        return resolveQualifiedConnectedAccountSettingsRoute({
            pluginId: qualifiedService.pluginId,
            localId: qualifiedService.localId,
            accountId: params.accountId ?? params.profileId,
            groupId: params.groupId,
            serverId: params.serverId,
            machineId: params.machineId,
        }, entries);
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
    const entry = resolvePublishedServiceEntry(entries, service.data);
    if (
        !entry
        || entry.legacyServiceId !== legacyServiceId.data
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
