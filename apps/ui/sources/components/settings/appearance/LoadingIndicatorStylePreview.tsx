import type { HappierSpinnerStyleId } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { TranslationKeyNoParams } from '@/text';

type LoadingIndicatorLabelKey = Extract<TranslationKeyNoParams, `settingsAppearance.loadingIndicatorOptions.${string}`>;

export const LOADING_INDICATOR_STYLE_LABEL_KEYS = {
    wave: 'settingsAppearance.loadingIndicatorOptions.wave',
    handwritten: 'settingsAppearance.loadingIndicatorOptions.handwritten',
    buildAndRelease: 'settingsAppearance.loadingIndicatorOptions.buildAndRelease',
    relay: 'settingsAppearance.loadingIndicatorOptions.relay',
    twinStems: 'settingsAppearance.loadingIndicatorOptions.twinStems',
    slowBreath: 'settingsAppearance.loadingIndicatorOptions.slowBreath',
    starfield: 'settingsAppearance.loadingIndicatorOptions.starfield',
    sweep: 'settingsAppearance.loadingIndicatorOptions.sweep',
    radar: 'settingsAppearance.loadingIndicatorOptions.radar',
    ripple: 'settingsAppearance.loadingIndicatorOptions.ripple',
    aurora: 'settingsAppearance.loadingIndicatorOptions.aurora',
    hWave: 'settingsAppearance.loadingIndicatorOptions.hWave',
    hHandwritten: 'settingsAppearance.loadingIndicatorOptions.hHandwritten',
    hBuildAndRelease: 'settingsAppearance.loadingIndicatorOptions.hBuildAndRelease',
    hRelay: 'settingsAppearance.loadingIndicatorOptions.hRelay',
    hTwinStems: 'settingsAppearance.loadingIndicatorOptions.hTwinStems',
    hSlowBreath: 'settingsAppearance.loadingIndicatorOptions.hSlowBreath',
    hStarfield: 'settingsAppearance.loadingIndicatorOptions.hStarfield',
    hSweep: 'settingsAppearance.loadingIndicatorOptions.hSweep',
    hRadar: 'settingsAppearance.loadingIndicatorOptions.hRadar',
    hRipple: 'settingsAppearance.loadingIndicatorOptions.hRipple',
    hAurora: 'settingsAppearance.loadingIndicatorOptions.hAurora',
    classicRing: 'settingsAppearance.loadingIndicatorOptions.classicRing',
} as const satisfies Record<HappierSpinnerStyleId, LoadingIndicatorLabelKey>;

/**
 * A live preview of one style, sized like the other appearance option icons. Decorative: the option
 * title already names the style, so the sample stays out of the accessibility tree rather than
 * announcing a progress bar for work that is not happening.
 */
export function LoadingIndicatorStylePreview(props: Readonly<{ styleId: HappierSpinnerStyleId }>) {
    return (
        <View
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
        >
            <ActivitySpinner variant={props.styleId} size={22} />
        </View>
    );
}
