import type { FeatureDecision } from '@happier-dev/protocol';

import { readServerEnabledBit } from '@happier-dev/protocol';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

export function useChannelBridgesRuntimeVisibility() {
    const channelBridgesDecision = useFeatureDecision('channelBridges', { scopeKind: 'runtime' });
    const telegramDecision = useFeatureDecision('channelBridges.telegram', { scopeKind: 'runtime' });

    const loading = channelBridgesDecision === null;
    const supported = channelBridgesDecision?.state !== 'unsupported';
    const needsLocalEnablement = channelBridgesDecision?.blockedBy === 'local_policy';
    const telegramEnabled = telegramDecision?.state === 'enabled';
    const showSettingsEntry = channelBridgesDecision?.state === 'enabled' && telegramEnabled;

    return {
        channelBridgesDecision,
        telegramDecision,
        loading,
        supported,
        needsLocalEnablement,
        telegramEnabled,
        showSettingsEntry,
    } as const;
}

export function isChannelBridgesFamilyHardDisabledByServer(snapshot: ServerFeaturesSnapshot): boolean {
    if (snapshot.status === 'error') return false;
    if (snapshot.status === 'unsupported') return true;

    return readServerEnabledBit(snapshot.features, 'channelBridges') !== true
        || readServerEnabledBit(snapshot.features, 'channelBridges.telegram') !== true;
}

export function isChannelBridgesRuntimeEnabled(decision: FeatureDecision | null): boolean {
    return decision?.state === 'enabled';
}
