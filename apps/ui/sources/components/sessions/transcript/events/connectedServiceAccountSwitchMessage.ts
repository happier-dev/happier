import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedServiceShortName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { t } from '@/text';

type ConnectedServiceAccountSwitchEvent = Readonly<{
    serviceId: ConnectedServiceId;
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

function resolveSwitchProfileLabel(params: Readonly<{
    serviceId: ConnectedServiceId;
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
    const provider = resolveConnectedServiceShortName(params.event.serviceId, t);
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
