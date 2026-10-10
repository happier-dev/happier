import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceCredentialKind } from '@happier-dev/protocol/connect/connectedServiceCredentialKind';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type {
    ConnectedServicesAccountGroupOption,
    ConnectedServicesProfileOption,
} from '@happier-dev/agents';

import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';
import { presentQualifiedConnectedAccountTarget, resolveQualifiedConnectedAccountGroupLabel } from './qualifiedConnectedAccountTargetPresentation';
import { resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences';

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
}>): Readonly<Record<string, ConnectedServicesProfileOption[]>> {
    const supported = new Set<string>(params.supportedServiceIds);
    const options: Record<string, ConnectedServicesProfileOption[]> = {};
    for (const account of params.accounts) {
        const serviceKey = buildQualifiedPluginContributionKey(account.ref.service);
        if (!supported.has(serviceKey)) continue;
        const presentation = params.presentIdentity ? presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: account.ref }, accounts: [account], groups: [],
            labelsByKey: params.labelsByKey, serviceTitle: null, presentIdentity: params.presentIdentity,
        }) : null;
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
 * Applies each Agent purpose declaration's public credential-kind contract.
 * Bundled and external Agents flow through the same projected declaration;
 * absence means unrestricted, and an unknown profile kind remains usable.
 */
export function applyProjectedCredentialKindRestrictions(params: Readonly<{
    optionsByServiceId: Readonly<Record<string, ReadonlyArray<ConnectedServicesProfileOption>>>;
    connectedAccounts: ReadonlyArray<Readonly<{
        purpose?: unknown;
        service: { pluginId: string; localId: string };
        credentialKinds?: ReadonlyArray<ConnectedServiceCredentialKind>;
    }>>;
}>): Readonly<Record<string, ConnectedServicesProfileOption[]>> {
    const allowedKindsByServiceKey = new Map<string, ReadonlySet<'oauth' | 'token'>>();
    for (const declaration of params.connectedAccounts) {
        if (!declaration.credentialKinds?.length) continue;
        allowedKindsByServiceKey.set(
            buildQualifiedPluginContributionKey(declaration.service),
            new Set(declaration.credentialKinds),
        );
    }
    const out: Record<string, ConnectedServicesProfileOption[]> = {};
    for (const [serviceKey, serviceOptions] of Object.entries(params.optionsByServiceId)) {
        const allowedKinds = allowedKindsByServiceKey.get(serviceKey);
        out[serviceKey] = allowedKinds
            ? serviceOptions.map((option) => {
                const kindSupported = !option.kind || allowedKinds.has(option.kind);
                return kindSupported ? option : { ...option, status: 'unsupported_kind' as const };
            })
            : [...serviceOptions];
    }
    return out;
}
