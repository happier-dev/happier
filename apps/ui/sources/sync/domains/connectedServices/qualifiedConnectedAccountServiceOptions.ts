import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol/connect/connected-service-bindings';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type {
    ConnectedServicesAccountGroupOption,
    ConnectedServicesProfileOption,
} from '@happier-dev/agents';

import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';
import { presentConnectedAccountNames, resolveQualifiedConnectedAccountGroupLabel } from './qualifiedConnectedAccountTargetPresentation';
import { resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences';
import { humanizeConnectedServiceIdentity } from './connectedServiceIdentityLabel';

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

export function buildQualifiedConnectedAccountProfileOptionsByServiceId(params: Readonly<{
    accounts: ReadonlyArray<QualifiedConnectedAccountProfileV4>;
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
    labelsByKey: Record<string, string | undefined>;
    presentIdentity?: ConnectedAccountIdentityPresenter;
    /** The service's display name, so an account with neither a name nor an email reads "<Service> account". */
    resolveServiceTitle?: (serviceKey: ConnectedAccountServiceKey) => string;
}>): Readonly<Record<string, ConnectedServicesProfileOption[]>> {
    const supported = new Set<string>(params.supportedServiceIds);
    const options: Record<string, ConnectedServicesProfileOption[]> = {};
    // Name the visible list together, once: isolated projections cannot distinguish matching names.
    const names = params.presentIdentity ? presentConnectedAccountNames(params.accounts.flatMap(account => {
        const serviceKey = buildQualifiedPluginContributionKey(account.ref.service);
        if (!supported.has(serviceKey)) return [];
        return [{
            key: connectedEntitySubjectKeyV1({ kind: 'account', account: account.ref }),
            serviceTitle: params.resolveServiceTitle?.(serviceKey) ?? humanizeConnectedServiceIdentity(account.ref.service.localId),
            userLabel: resolveQualifiedConnectedAccountLabel({ labelsByKey: params.labelsByKey,
                service: account.ref.service, accountId: account.ref.accountId }),
            displayName: account.displayName,
            email: account.providerIdentity?.email,
            providerAccountId: account.providerIdentity?.accountId,
            accountId: account.ref.accountId,
            presentIdentity: params.presentIdentity,
        }];
    })) : null;
    for (const account of params.accounts) {
        const serviceKey = buildQualifiedPluginContributionKey(account.ref.service);
        if (!supported.has(serviceKey)) continue;
        const presentation = names?.get(connectedEntitySubjectKeyV1({ kind: 'account', account: account.ref }));
        const email = account.providerIdentity?.email ?? null;
        (options[serviceKey] ??= []).push({
            profileId: account.ref.accountId,
            status: account.status,
            kind: account.kind ?? null,
            providerEmail: params.presentIdentity ? params.presentIdentity({ email }).email : email,
            // Without a device presentation policy this remains a transport projection:
            // derived identities must not be promoted into a generic name field.
            label: presentation ? presentation.primaryLabel
                : resolveQualifiedConnectedAccountLabel({
                    labelsByKey: params.labelsByKey, service: account.ref.service, accountId: account.ref.accountId,
                }) ?? (account.displayName?.trim() || null),
        });
    }
    return options;
}

export function buildQualifiedConnectedAccountGroupOptionsByServiceId(params: Readonly<{
    groups: ReadonlyArray<QualifiedConnectedAccountGroupV4>;
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
    labelsByKey?: Readonly<Record<string, string | undefined>>;
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
                label: (params.labelsByKey ? resolveQualifiedConnectedAccountGroupLabel({ group: group.ref, labelsByKey: params.labelsByKey }) : null)
                    ?? group.displayName ?? group.ref.groupId,
                activeProfileId,
                memberProfileIds,
                ...(group.policy.quotaLimitSelection ? { quotaLimitSelection: group.policy.quotaLimitSelection } : {}),
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

// Shared with CLI Actions; UI surfaces consume the same declaration decision.
export { applyProjectedCredentialKindRestrictions } from '@happier-dev/agents';
