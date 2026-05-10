import * as React from 'react';

import { ONBOARDING_SHOWCASE_MANIFEST } from './manifest';
import {
    getShowcaseSeenVersion,
    setShowcaseSeenVersion,
    subscribeShowcaseSeenVersion,
} from './storage';
import type { OnboardingShowcaseManifest } from './types';

export type UseOnboardingShowcaseStateResult = Readonly<{
    manifest: OnboardingShowcaseManifest;
    hasUnread: boolean;
    markSeen: () => void;
}>;

export function useOnboardingShowcaseState(): UseOnboardingShowcaseStateResult {
    const seenVersion = React.useSyncExternalStore(
        subscribeShowcaseSeenVersion,
        getShowcaseSeenVersion,
        getShowcaseSeenVersion,
    );
    const hasUnread = seenVersion !== ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion;

    const markSeen = React.useCallback(() => {
        setShowcaseSeenVersion(ONBOARDING_SHOWCASE_MANIFEST.showcaseVersion);
    }, []);

    return {
        manifest: ONBOARDING_SHOWCASE_MANIFEST,
        hasUnread,
        markSeen,
    };
}
