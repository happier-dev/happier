import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import {
    resolveConnectedServiceShortName,
    resolveQualifiedConnectedServiceRegistryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { getConnectedServiceRegistrySnapshot, resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { presentConnectedAccountNames, type QualifiedConnectedAccountPresentationAccount } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import type { ConnectedAccountIdentityPresenter } from '@/sync/domains/connectedServices/maskAccountEmail';
import { t } from '@/text';

type ConnectedServiceAccountSwitchEvent = Readonly<{
    /** Canonical qualified key on current writers; released bundled scalar ids retain legacy display. */
    serviceId: string;
    groupId: string | null;
    groupLabel?: string | null;
    fromProfileId: string | null;
    toProfileId: string | null;
    fromProfileLabel?: string | null;
    toProfileLabel?: string | null;
}>;

function readDisplayLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Daemon-produced service ids are canonical qualified keys: resolve the short
 * brand name or public descriptor title from the applied projection, with a
 * neutral fallback for an unknown service. Released bundled scalar ids keep
 * the generated built-in compatibility display.
 */
function resolveSwitchServiceDisplay(serviceId: string): string {
    const qualifiedService = parseQualifiedPluginContributionKey(serviceId);
    if (qualifiedService) {
        const entryShortName = getConnectedServiceRegistrySnapshot()
            .entries.find((candidate) => (
                candidate.service?.pluginId === qualifiedService.pluginId
                && candidate.service.localId === qualifiedService.localId
            ))
            ?.shortName?.trim();
        if (entryShortName) return entryShortName;
        return resolveQualifiedConnectedServiceRegistryDisplayName(
            getConnectedServiceRegistrySnapshot(),
            qualifiedService,
            t,
        );
    }
    return resolveConnectedServiceShortName(serviceId as ConnectedServiceId, t);
}

export function buildConnectedServiceAccountSwitchMessage(params: Readonly<{
    event: ConnectedServiceAccountSwitchEvent;
    labelsByKey: Readonly<Record<string, string | undefined>> | undefined;
    accounts?: readonly QualifiedConnectedAccountPresentationAccount[];
    presentIdentity?: ConnectedAccountIdentityPresenter;
}>): string {
    const labelsByKey = params.labelsByKey ?? {};
    const provider = resolveSwitchServiceDisplay(params.event.serviceId);
    const serviceKey = resolveQualifiedConnectedAccountServiceKey(params.event.serviceId);
    const service = serviceKey ? parseQualifiedPluginContributionKey(serviceKey) : null;
    const accounts = service ? (params.accounts ?? []).filter(account => account.ref.service.pluginId === service.pluginId
        && account.ref.service.localId === service.localId) : [];
    const accountsById = new Map(accounts.map(account => [account.ref.accountId, account] as const));
    const nameEntry = (profileId: string | null, profileLabel?: string | null) => {
        const accountId = readDisplayLabel(profileId);
        const account = accountId ? accountsById.get(accountId) : undefined;
        return {
            key: accountId ? `account:${accountId}` : 'native', serviceTitle: provider, accountId,
            userLabel: accountId ? resolveConnectedServiceProfileLabel({ labelsByKey, serviceId: serviceKey ?? params.event.serviceId, profileId: accountId })
                ?? resolveConnectedServiceProfileLabel({ labelsByKey, serviceId: params.event.serviceId, profileId: accountId })
                : t('connectedServices.authModal.nativeAuthTitle'),
            displayName: account?.displayName ?? readDisplayLabel(profileLabel),
            email: account?.providerIdentity?.email,
            providerAccountId: account?.providerIdentity?.accountId,
            presentIdentity: params.presentIdentity,
        };
    };
    const sides = [
        nameEntry(params.event.fromProfileId, params.event.fromProfileLabel),
        nameEntry(params.event.toProfileId, params.event.toProfileLabel),
    ];
    // A third account can share an endpoint's name even when the two switched names differ.
    const names = presentConnectedAccountNames([...sides, ...accounts.map(account => nameEntry(account.ref.accountId))]);
    const fromName = names.get(sides[0]!.key)!;
    const toName = names.get(sides[1]!.key)!;
    const from = fromName.inlineLabel ?? fromName.primaryLabel;
    const to = toName.inlineLabel ?? toName.primaryLabel;
    const groupId = readDisplayLabel(params.event.groupId);
    if (groupId !== null) {
        return t('message.connectedServiceGroupAccountSwitch', {
            provider,
            group: readDisplayLabel(params.event.groupLabel) ?? groupId,
            from,
            to,
        });
    }
    return t('message.connectedServiceAccountSwitch', { provider, from, to });
}
