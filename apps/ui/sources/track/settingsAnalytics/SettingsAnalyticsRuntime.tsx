import React from 'react';

import { getTrackingAnonymousUserId, subscribeTrackingAnonymousUserId } from '@/track';
import { tracking } from '@/track/tracking';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useLocalSettings, useSettings } from '@/sync/store/hooks';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildFeatureAnalyticsSnapshot } from './buildFeatureAnalyticsSnapshot';
import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';
import { diffAnalyticsProperties } from './diffAnalyticsSnapshot';
import { getDeviceAnalyticsId } from './deviceAnalyticsIdentity';
import { flushTrackingClient } from './flushTrackingClient';

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
    const previousAccountPropertiesRef = React.useRef<Record<string, string | number | boolean | null> | null>(null);
    const previousLocalPropertiesRef = React.useRef<Record<string, string | number | boolean | null> | null>(null);

    React.useEffect(() => {
        previousAccountPropertiesRef.current = null;
        previousLocalPropertiesRef.current = null;
    }, [anonymousUserId]);

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
        const changedAccountProperties = diffAnalyticsProperties(previousAccountPropertiesRef.current, accountProperties);
        let didEmitAnalyticsUpdate = false;

        if (changedAccountProperties) {
            tracking.identify(anonymousUserId, changedAccountProperties);
            didEmitAnalyticsUpdate = true;
        }
        previousAccountPropertiesRef.current = accountProperties;

        const deviceAnalyticsId = getDeviceAnalyticsId();
        if (deviceAnalyticsId) {
            const changedLocalProperties = diffAnalyticsProperties(previousLocalPropertiesRef.current, localSnapshot.properties);
            if (changedLocalProperties) {
                tracking.group('device_user', `${anonymousUserId}:${deviceAnalyticsId}`, changedLocalProperties);
                didEmitAnalyticsUpdate = true;
            }
        }
        previousLocalPropertiesRef.current = localSnapshot.properties;

        if (didEmitAnalyticsUpdate) {
            flushTrackingClient(tracking);
        }
    }, [anonymousUserId, localSettings, mainSelectionSnapshot, settings]);

    return null;
}
