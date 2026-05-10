import type { AccountProfile } from '@happier-dev/protocol';

import type { ExternalSessionBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { Settings } from '@/sync/domains/settings/settings';
import { t } from '@/text';

type ExternalSessionBrowseSettings = Pick<Settings, 'connectedServicesProfileLabelByKey'>;

function resolveCodexConnectedServiceOptions(params: Readonly<{
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: ExternalSessionBrowseSettings;
}>): ExternalSessionBrowseSourceOption[] {
    const service = params.profile?.connectedServicesV2.find((entry) => entry.serviceId === 'openai-codex');
    if (!service || service.profiles.length === 0) return [];

    return service.profiles.map((profile) => ({
        key: `codex:connected-service:${service.serviceId}:${profile.profileId}`,
        label: t('externalSessions.browseSourceCodexConnectedServices', {
            service: resolveConnectedServiceDisplayName(service.serviceId, t),
        }),
        detail: resolveConnectedServiceProfileLabel({
            labelsByKey: params.settings.connectedServicesProfileLabelByKey,
            serviceId: service.serviceId,
            profileId: profile.profileId,
        }) ?? profile.profileId,
        source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: service.serviceId,
            connectedServiceProfileId: profile.profileId,
        },
    }));
}

export function resolveCodexBrowseSourceOptions(params: Readonly<{
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: ExternalSessionBrowseSettings;
}>): readonly ExternalSessionBrowseSourceOption[] {
    const out: ExternalSessionBrowseSourceOption[] = [{
        key: 'codex:user',
        label: t('externalSessions.browseSourceCodexUserHome'),
        source: { kind: 'codexHome', home: 'user' },
    }];

    out.push(...resolveCodexConnectedServiceOptions(params));

    return out;
}
