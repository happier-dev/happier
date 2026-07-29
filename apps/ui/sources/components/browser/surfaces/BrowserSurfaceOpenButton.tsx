import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

function decisionEnabled(decision: ReturnType<typeof useFeatureDecision>): boolean {
    return decision?.state === 'enabled';
}

/**
 * The disabled reason is expressed in the canonical surface-state vocabulary
 * ({@link BrowserSurfaceUnavailableReason}) so the accessibility hint resolves through the ONE
 * owner-copy mapper ({@link resolveReasonCopy}) — never by interpolating a raw internal code into
 * user-facing/accessibility text.
 */
function resolveDisabledReason(params: Readonly<{
    browserEnabled: boolean;
    viewTargetsEnabled: boolean;
}>): Extract<BrowserSurfaceUnavailableReason, 'disabled' | 'view_targets_disabled'> | null {
    if (!params.browserEnabled) return 'disabled';
    if (!params.viewTargetsEnabled) return 'view_targets_disabled';
    return null;
}

export function BrowserSurfaceOpenButton(props: Readonly<{
    onPress: () => void;
    testID: string;
    style?: StyleProp<ViewStyle>;
    disabledStyle?: StyleProp<ViewStyle>;
    iconColor?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const browserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const viewTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const disabledReason = resolveDisabledReason({
        browserEnabled: decisionEnabled(browserDecision),
        viewTargetsEnabled: decisionEnabled(viewTargetsDecision),
    });
    const disabled = disabledReason !== null;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={disabled
                ? t('browserSurface.openDisabledA11y')
                : t('browserSurface.openA11y')}
            accessibilityHint={disabled && disabledReason
                ? resolveReasonCopy({ reasonCode: disabledReason, kind: 'browserSurface' }).message
                : t('browserSurface.openHint')}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => {
                if (!disabled) {
                    props.onPress();
                }
            }}
            style={[props.style, disabled ? props.disabledStyle : null]}
        >
            <Ionicons
                name="globe-outline"
                size={18}
                color={disabled ? theme.colors.text.disabled : props.iconColor ?? theme.colors.text.secondary}
            />
        </Pressable>
    );
}
