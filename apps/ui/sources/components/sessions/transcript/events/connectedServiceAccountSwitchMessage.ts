import type { ConnectedServiceId } from '@happier-dev/protocol';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol';

import {
    resolveConnectedServiceShortName,
    resolveQualifiedConnectedServiceRegistryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
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

function resolveSwitchProfileLabel(params: Readonly<{
    serviceId: string;
    profileId: string | null;
    profileLabel?: string | null;
    labelsByKey: Readonly<Record<string, string | undefined>>;
}>): string {
    if (params.profileId === null || params.profileId.trim().length === 0) {
        return t('connectedServices.authChip.nativeLabel');
    }
    return readDisplayLabel(params.profileLabel) ?? resolveConnectedServiceProfileLabel({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId: params.profileId,
    }) ?? params.profileId;
}

export function buildConnectedServiceAccountSwitchMessage(params: Readonly<{
    event: ConnectedServiceAccountSwitchEvent;
    labelsByKey: Readonly<Record<string, string | undefined>> | undefined;
}>): string {
    const labelsByKey = params.labelsByKey ?? {};
    const provider = resolveSwitchServiceDisplay(params.event.serviceId);
    const from = resolveSwitchProfileLabel({
        serviceId: params.event.serviceId,
        profileId: params.event.fromProfileId,
        profileLabel: params.event.fromProfileLabel,
        labelsByKey,
    });
    const to = resolveSwitchProfileLabel({
        serviceId: params.event.serviceId,
        profileId: params.event.toProfileId,
        profileLabel: params.event.toProfileLabel,
        labelsByKey,
    });
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
