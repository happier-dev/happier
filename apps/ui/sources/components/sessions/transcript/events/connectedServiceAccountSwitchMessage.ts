import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedServiceShortName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { t } from '@/text';

type ConnectedServiceAccountSwitchEvent = Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string | null;
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
 * Builds the human-readable description of a single switch endpoint.
 *
 * The switch event carries one `groupId` (the group context for the switch) plus the resolved
 * `from`/`to` profile ids. When a group drove the switch, the originating endpoint is described as a
 * group selection ("group Codex · <fromLabel>") and the resulting endpoint as the profile that became
 * active ("profile <toLabel>"). Direct (non-group) switches describe both endpoints as profiles. Each
 * profile resolves to its display label first (event-carried label, then profile-label settings), and
 * falls back to the id only when no label is configured; a missing profile resolves to the native
 * CLI-auth label.
 */
function resolveSwitchEndpointLabel(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string | null;
    profileLabel?: string | null;
    groupId: string | null;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    role: 'from' | 'to';
}>): string {
    if (params.profileId === null || params.profileId.trim().length === 0) {
        return t('connectedServices.authChip.nativeLabel');
    }
    const profileLabel = readDisplayLabel(params.profileLabel) ?? resolveConnectedServiceProfileLabel({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId: params.profileId,
    }) ?? params.profileId;

    const hasGroup = typeof params.groupId === 'string' && params.groupId.trim().length > 0;
    // A group-driven switch originates from the group selection and resolves to the active member
    // profile; describe the originating endpoint as the group and the resulting endpoint as a profile.
    if (hasGroup && params.role === 'from') {
        return t('message.connectedServiceSwitchGroupEndpoint', {
            group: resolveConnectedServiceShortName(params.serviceId, t),
            profile: profileLabel,
        });
    }
    return t('message.connectedServiceSwitchProfileEndpoint', { profile: profileLabel });
}

export function buildConnectedServiceAccountSwitchMessage(params: Readonly<{
    event: ConnectedServiceAccountSwitchEvent;
    labelsByKey: Readonly<Record<string, string | undefined>> | undefined;
}>): string {
    const labelsByKey = params.labelsByKey ?? {};
    return t('message.connectedServiceAccountSwitch', {
        provider: resolveConnectedServiceShortName(params.event.serviceId, t),
        from: resolveSwitchEndpointLabel({
            serviceId: params.event.serviceId,
            profileId: params.event.fromProfileId,
            profileLabel: params.event.fromProfileLabel,
            groupId: params.event.groupId,
            labelsByKey,
            role: 'from',
        }),
        to: resolveSwitchEndpointLabel({
            serviceId: params.event.serviceId,
            profileId: params.event.toProfileId,
            profileLabel: params.event.toProfileLabel,
            groupId: params.event.groupId,
            labelsByKey,
            role: 'to',
        }),
    });
}
