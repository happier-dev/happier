import * as React from 'react';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
import { resolveActivitySurfaceDeliveryAdmission } from '@/activity/delivery/resolveActivitySurfaceDeliveryAdmission';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { buildSharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type { PetCompanionActivityModel } from './petCompanionActivityTypes';

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const source = useActivityAttentionSummarySource();
    const isSessionVisible = useSessionRecordingVisibility();
    const resolveAccountSettings = useExactHomeAccountSettings(source.audienceScopes);
    const activitySurfacesEnabled = useLocalSetting('activitySurfacesEnabled');
    const activitySurfacePrivacyMode = useLocalSetting('activitySurfacePrivacyMode');
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');
    const desktopOverlayEnabled = useLocalSetting('desktopOverlayEnabled');
    const availability = useDesktopHostRoleAvailability('activity');
    const settings = React.useMemo(() => ({ activitySurfacesEnabled, activitySurfacePrivacyMode,
        attentionDeviceOverridesV1 }), [activitySurfacesEnabled, activitySurfacePrivacyMode, attentionDeviceOverridesV1]);
    const projection = React.useMemo(() => {
        const now = new Date(Date.now());
        const overview = buildActivityOverviewFromSource({ source, nowMs: now.getTime(), includeWarmSourceWhenNotReady: true });
        const admission = resolveActivitySurfaceDeliveryAdmission({ candidates: overview.candidates.filter(candidate => isSessionVisible(candidate.address ?? candidate)),
            surface: 'desktop_overlay', resolveAccountSettings, localSettings: settings, now,
            audienceScopes: source.audienceScopes, accountDeliveryMutesByServerId: source.accountDeliveryMutesByServerId });
        return buildSharedActivityProjection({ admission, policy: resolveActivitySurfacePolicy(settings) });
    }, [source, resolveAccountSettings, settings, isSessionVisible]);
    // The character remains independent; one supported island owns the attention tray.
    const suppressTray = desktopOverlayEnabled && availability?.kind === 'available';
    return React.useMemo(() => buildPetCompanionActivityModel({
        projection: suppressTray ? { ...projection, tray: [] } : projection,
        dismissedTrayItemKeys: input?.dismissedTrayItemKeys,
    }), [projection, suppressTray, input?.dismissedTrayItemKeys]);
}
