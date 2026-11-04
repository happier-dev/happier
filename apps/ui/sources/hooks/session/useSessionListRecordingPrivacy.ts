import { useMemo, useSyncExternalStore } from 'react';
import { useCapturePrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { useSetting } from '@/sync/domains/state/storage';
import { readRecordingHiddenSessionKeys } from '@/sync/domains/session/listing/recordingPrivacy';
import type { SessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { ALL_SESSIONS_RECORDING_VISIBLE, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import { readSessionRecordingVisibility, subscribeSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';

const readAllVisible = () => ALL_SESSIONS_RECORDING_VISIBLE;
const subscribeInactive = () => () => {};

/** Shared presentation policy for Session enumerations and incidental identity labels. */
export function useSessionRecordingVisibility(enabled = true): SessionRecordingVisibility {
    return useSyncExternalStore(enabled ? subscribeSessionRecordingVisibility : subscribeInactive,
        enabled ? readSessionRecordingVisibility : readAllVisible, readAllVisible);
}

/** Shared list policy: deliberate Account preference joined with capture activity and tag owners. */
export function useSessionListRecordingPrivacy(
    organization: Pick<SessionOrganizationListViewState, 'sessionTagIdsBySessionKey' | 'orderItemAddressByItemKey'>,
    enabled = true,
): ReadonlySet<string> {
    const hiddenTags = useSetting('sessionListHiddenTagIdsWhileRecording');
    const privacyActive = useCapturePrivacyActive(enabled && Object.values(hiddenTags ?? {}).some(tags => tags.length > 0));
    return useMemo(() => readRecordingHiddenSessionKeys(privacyActive, hiddenTags ?? {}, organization),
        [privacyActive, hiddenTags, organization.sessionTagIdsBySessionKey, organization.orderItemAddressByItemKey]);
}
