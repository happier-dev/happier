import * as React from 'react';
import {
    HAPPIER_COMPOSER_STATUS_BADGE_METRICS,
    HAPPIER_COMPOSER_STATUS_BADGE_TYPE,
    HappierComposerStatusBadge,
    resolveHappierComposerStatusState,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor } from '../agentInputContracts';

type AgentInputStatusBadgeProps = AgentInputStatusBadgeDescriptor & Readonly<{
    anchorRef?: React.RefObject<any>;
}>;

/**
 * Core's adapter over the shared composer status item (`HappierComposerStatusBadge`): it supplies the
 * app's scaled `Text`, its `Icon` caret and the Unistyles state colours. Chrome, rhythm, the caret rule
 * and press semantics stay in the shared owner, which plugin authors reach as `ComposerStatusBadge`.
 */
export function AgentInputStatusBadge(props: AgentInputStatusBadgeProps) {
    const { theme } = useUnistyles();
    const emphasis = props.emphasis ?? 'prominent';
    const state = theme.colors.state[resolveHappierComposerStatusState(props.tone ?? 'neutral')];
    // The state hue lives in the fill and the leading glyph; the label stays in the primary text role
    // (lab `.l12-sb`), which clears AA on every state tint in both themes. Painting the label the accent
    // would read as one colour but measures 2.09:1 on the light warning tint. A quiet item has no tint
    // and sits among the strip's secondary-ink values, so its plain words take the secondary role.
    const ink = emphasis === 'quiet' ? theme.colors.text.secondary : theme.colors.text.primary;
    const numberOfLines = props.labelNumberOfLines ?? 1;

    return (
        <HappierComposerStatusBadge
            label={props.label}
            text={(
                <Text
                    testID={props.testID ? `${props.testID}:label` : undefined}
                    numberOfLines={numberOfLines}
                    ellipsizeMode="tail"
                    style={[emphasis === 'quiet' ? styles.quietLabel : styles.prominentLabel, { color: ink }]}
                >
                    {props.label}
                </Text>
            )}
            leading={props.icon ? props.icon(state.foreground) : undefined}
            caret={(
                <Icon
                    name="caret-down"
                    size={HAPPIER_COMPOSER_STATUS_BADGE_METRICS.caretSize}
                    color={theme.colors.text.tertiary}
                    testID={props.testID ? `${props.testID}:caret` : undefined}
                />
            )}
            opensPopover={props.renderPopover !== undefined}
            emphasis={emphasis}
            tintColor={state.background}
            inkColor={ink}
            onPress={props.onPress}
            anchorRef={props.anchorRef}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityState={props.accessibilityState}
            testID={props.testID}
        />
    );
}

const PROMINENT_TYPE = HAPPIER_COMPOSER_STATUS_BADGE_TYPE.prominent;
const QUIET_TYPE = HAPPIER_COMPOSER_STATUS_BADGE_TYPE.quiet;

const styles = StyleSheet.create(() => ({
    prominentLabel: {
        ...Typography.variant(PROMINENT_TYPE.role, PROMINENT_TYPE.emphasis),
        letterSpacing: PROMINENT_TYPE.letterSpacing,
        flexShrink: 1,
        minWidth: 0,
    },
    quietLabel: {
        ...Typography.variant(QUIET_TYPE.role, QUIET_TYPE.emphasis),
        letterSpacing: QUIET_TYPE.letterSpacing,
        flexShrink: 1,
        minWidth: 0,
    },
}));
