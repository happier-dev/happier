import * as React from 'react';
import { Animated } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DETAILS_TAB_HEADER_METRICS, DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { describeTerminalAddress } from '../presentation/describeSessionTerminal';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

/** How long the arrival ring stays before it settles into the ordinary hairline (terminal lab L). */
const ARRIVAL_RING_MS = 1600;
const ARRIVAL_RISE_PX = 4;

/**
 * Terminal lab L, the signature: when a terminal prints a local address, the strip grows a live pill
 * "localhost:5173 · Open". It arrives once (a 4 px rise and fade, one soft green ring) and then sits
 * still: nothing pulses beside a terminal.
 */
export const SessionTerminalLivePill = React.memo(function SessionTerminalLivePill(props: Readonly<{
    url: string;
    onOpen: (url: string) => void;
    testID?: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const arrival = React.useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
    const [ringing, setRinging] = React.useState(true);
    React.useEffect(() => {
        const animation = Animated.timing(arrival, {
            toValue: 1,
            duration: reducedMotion ? 0 : 200,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        });
        animation.start();
        const timer = setTimeout(() => setRinging(false), ARRIVAL_RING_MS);
        return () => { animation.stop(); clearTimeout(timer); };
    }, [arrival, props.url, reducedMotion]);
    const address = describeTerminalAddress(props.url);
    return (
        <Animated.View
            testID={props.testID}
            style={[
                styles.pill,
                ringing ? styles.pillFresh : null,
                { opacity: arrival, transform: [{ translateY: arrival.interpolate({ inputRange: [0, 1], outputRange: [ARRIVAL_RISE_PX, 0] }) }] },
            ]}
        >
            <Icon name="globe" size={12} color={theme.colors.text.secondary} />
            <Text style={styles.address} numberOfLines={1}>{address}</Text>
            <HappierPressable
                testID={props.testID ? `${props.testID}-open` : undefined}
                accessibilityRole="button"
                accessibilityLabel={t('terminalWorkspace.livePill.a11y', { address })}
                onPress={() => props.onOpen(props.url)}
                style={({ pressed }) => [styles.open, pressed ? { opacity: motionTokens.press.opacity } : null]}
            >
                <Icon name="arrow-square-out" size={10} color={theme.colors.surface.base} />
                <Text style={styles.openLabel}>{t('terminalWorkspace.livePill.open')}</Text>
            </HappierPressable>
        </Animated.View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    pill: {
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 8,
        paddingRight: 3,
        borderRadius: 11,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        marginRight: 6,
        flexShrink: 1,
        minWidth: 0,
    },
    pillFresh: {
        borderColor: theme.colors.status.connected,
    },
    address: {
        ...DETAILS_TAB_HEADER_METRICS.pane.meta,
        color: theme.colors.text.primary,
        ...Typography.default(),
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
    },
    open: {
        height: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 7,
        borderRadius: 8,
        backgroundColor: theme.colors.text.primary,
    },
    openLabel: {
        ...DETAILS_TAB_STRIP_METRICS.tabSubtitle,
        color: theme.colors.surface.base,
        ...Typography.default('semiBold'),
    },
}));
