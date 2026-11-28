import React from 'react';

import { getTrackingAnonymousUserId, subscribeTrackingAnonymousUserId } from '@/track';
import { tracking } from '@/track/tracking';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useLocalSettings, useSettings } from '@/sync/store/hooks';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildFeatureAnalyticsSnapshot } from './buildFeatureAnalyticsSnapshot';
import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';
import { getDeviceAnalyticsId } from './deviceAnalyticsIdentity';
import { flushTrackingClient } from './flushTrackingClient';
import { takeAnalyticsPropertiesToSend } from './propertiesSendLedger';

export function SettingsAnalyticsRuntime() {
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const selection = useEffectiveServerSelection();
    const mainSelectionSnapshot = useServerFeaturesMainSelectionSnapshot(selection.serverIds, { enabled: true });
    const anonymousUserId = React.useSyncExternalStore(
        subscribeTrackingAnonymousUserId,
        getTrackingAnonymousUserId,
        getTrackingAnonymousUserId,
    );
    React.useEffect(() => {
        if (!tracking || !anonymousUserId) return;

        const accountSnapshot = buildAccountSettingsSnapshot(settings);
        const featureSnapshot = buildFeatureAnalyticsSnapshot({
            settings,
            mainSelectionSnapshot,
        });
        const localSnapshot = buildLocalSettingsSnapshot(localSettings);
        const accountProperties = {
            ...accountSnapshot.properties,
            ...featureSnapshot.properties,
        };
        let didEmitAnalyticsUpdate = false;

        const accountPropertiesToSend = takeAnalyticsPropertiesToSend('person', anonymousUserId, accountProperties);
        if (accountPropertiesToSend) {
            tracking.identify(anonymousUserId, accountPropertiesToSend);
            didEmitAnalyticsUpdate = true;
        }

        const deviceAnalyticsId = getDeviceAnalyticsId();
        if (deviceAnalyticsId) {
            const deviceUserKey = `${anonymousUserId}:${deviceAnalyticsId}`;
            const localPropertiesToSend = takeAnalyticsPropertiesToSend('device_user', deviceUserKey, localSnapshot.properties);
            if (localPropertiesToSend) {
                tracking.group('device_user', deviceUserKey, localPropertiesToSend);
                didEmitAnalyticsUpdate = true;
            }
        }

        if (didEmitAnalyticsUpdate) {
            flushTrackingClient(tracking);
        }
    }, [anonymousUserId, localSettings, mainSelectionSnapshot, settings]);

    return null;
}
