import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getTrackingAnonymousUserId, subscribeTrackingAnonymousUserId } from '@/track';
import { tracking } from '@/track/tracking';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useSettingsSelector } from '@/sync/store/hooks';
import { ACCOUNT_SETTING_ANALYTICS_ARTIFACTS } from '@/sync/domains/settings/registry/account/accountSettingAnalytics';
import { storage } from '@/sync/domains/state/storageStore';
import { LOCAL_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildFeatureAnalyticsSnapshot } from './buildFeatureAnalyticsSnapshot';
import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';
import { takeAnalyticsPropertiesToSend } from './propertiesSendLedger';
import { deriveDeviceUserGroupKey, getDeviceAnalyticsId } from './deviceAnalyticsIdentity';
import { flushTrackingClient } from './flushTrackingClient';

const accountAnalyticsKeys = [...new Set([
    ...Object.keys(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.trackedCurrentStateDefinitions),
    ...Object.keys(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.trackedDerivedDefinitions),
])] as (keyof Settings)[];

const localAnalyticsKeys = [...new Set([
    ...Object.entries(LOCAL_SETTING_ARTIFACTS.trackedCurrentStateDefinitions),
    ...Object.entries(LOCAL_SETTING_ARTIFACTS.trackedDerivedDefinitions),
].filter(([, definition]) => definition?.analytics?.identityScope === 'device_user')
    .map(([key]) => key))] as (keyof LocalSettings)[];

function selectAnalyticsSettings(settings: Settings): Partial<Settings> & FeatureLocalPolicySettings {
    return {
        ...Object.fromEntries(accountAnalyticsKeys.map((key) => [key, settings[key]])),
        experiments: settings.experiments,
        featureToggles: settings.featureToggles,
    };
}

export function SettingsAnalyticsRuntime() {
    const settings = useSettingsSelector(selectAnalyticsSettings, [...accountAnalyticsKeys, 'experiments', 'featureToggles']);
    const localSettings = storage(useShallow((state) => Object.fromEntries(
        localAnalyticsKeys.map((key) => [key, state.localSettings[key]]),
    )), { localSettings: localAnalyticsKeys });
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
        const accountPropertiesToSend = takeAnalyticsPropertiesToSend('person', anonymousUserId, accountProperties);
        let didEmitAnalyticsUpdate = false;

        if (accountPropertiesToSend) {
            tracking.identify(anonymousUserId, accountPropertiesToSend);
            didEmitAnalyticsUpdate = true;
        }

        const deviceAnalyticsId = getDeviceAnalyticsId();
        if (deviceAnalyticsId) {
            const deviceUserKey = deriveDeviceUserGroupKey(anonymousUserId, deviceAnalyticsId);
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
