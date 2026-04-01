import { t } from '@/text';

import type { RelayHostLocalChecklistItem, RelayHostLocalChecklistRuntimeStatus } from './types';

export function buildRelayHostLocalChecklistItems(params: Readonly<{
    runtimeStatus: RelayHostLocalChecklistRuntimeStatus | null;
    currentRelayUrl: string | null;
    currentShareableUrl: string | null;
}>): readonly RelayHostLocalChecklistItem[] {
    const status = params.runtimeStatus;
    const installed = status?.installed === true;
    const running = status?.service.active === true;
    const healthy = status?.healthy === true;
    const shareableReady = Boolean(params.currentShareableUrl);
    const relayRuntimeUrlKnown = installed && typeof status?.relayUrl === 'string' && status.relayUrl.trim().length > 0;

    const items: RelayHostLocalChecklistItem[] = [
        {
            id: 'installRelayRuntime',
            title: t('settings.localRelayRuntime.installOrUpdateAction'),
            subtitle: t('settings.localRelayRuntime.progressStepInstall'),
            badge: installed ? t('common.done') : t('setupOnboarding.recommendedBadge'),
            satisfied: installed,
            disabled: installed,
            defaultSelected: !installed,
            stepIds: ['relay.install'],
        },
        {
            id: 'startRelayRuntime',
            title: t('settings.localRelayRuntime.startAction'),
            subtitle: t('settings.localRelayRuntime.progressStepStart'),
            badge: running && healthy ? t('common.done') : t('setupOnboarding.recommendedBadge'),
            satisfied: running && healthy,
            disabled: running && healthy,
            defaultSelected: !(running && healthy),
            stepIds: ['relay.start', 'relay.status.inspect', 'relay.status.health'],
        },
    ];

    if (relayRuntimeUrlKnown) {
        items.push({
            id: 'enableSecureAccess',
            title: t('settings.localTailscale.title'),
            subtitle: t('settings.localTailscale.footer'),
            badge: shareableReady ? t('common.done') : t('setupOnboarding.recommendedBadge'),
            optional: true,
            satisfied: shareableReady,
            disabled: shareableReady,
            defaultSelected: !shareableReady,
            stepIds: ['tailscale.detect', 'tailscale.install', 'tailscale.login', 'tailscale.serveEnable', 'tailscale.verifyUrl'],
        });
    }

    return items;
}
