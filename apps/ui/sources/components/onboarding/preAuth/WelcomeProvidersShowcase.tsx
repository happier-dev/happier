import * as React from 'react';
import { Animated, Easing, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { lightTheme } from '@/theme';

export type WelcomeProvidersShowcaseProps = Readonly<{
    testIDPrefix?: string;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        alignItems: 'center',
        gap: theme.margins?.md ?? lightTheme.margins.md,
        paddingTop: 6,
    },
    label: {
        ...Typography.default(),
        fontSize: 16,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    showcaseFrame: {
        width: '100%',
        maxWidth: 420,
        paddingVertical: theme.margins?.sm ?? lightTheme.margins.sm,
        paddingHorizontal: theme.margins?.sm ?? lightTheme.margins.sm,
        overflow: 'hidden',
        gap: theme.margins?.sm ?? lightTheme.margins.sm,
    },
    rowViewport: {
        width: '100%',
        overflow: 'hidden',
        alignItems: 'center',
    },
    rowTrack: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: theme.margins?.sm ?? lightTheme.margins.sm,
    },
    cell: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center'
    },
}));

export const WelcomeProvidersShowcase = React.memo(function WelcomeProvidersShowcase(props: WelcomeProvidersShowcaseProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const reduceMotion = useReducedMotionPreference();
    const margins = theme.margins ?? lightTheme.margins;

    const evenAgentIds = React.useMemo(() => AGENT_IDS.filter((_, index) => index % 2 === 0), []);
    const oddAgentIds = React.useMemo(() => AGENT_IDS.filter((_, index) => index % 2 === 1), []);

    const [viewportWidth, setViewportWidth] = React.useState<number | null>(null);
    const cellPitch = 44 + margins.sm;
    const evenRowWidth = Math.max(0, (evenAgentIds.length * cellPitch) - margins.sm);
    const oddRowWidth = Math.max(0, (oddAgentIds.length * cellPitch) - margins.sm);
    const evenTravel = viewportWidth == null ? 0 : Math.max(0, evenRowWidth - viewportWidth);
    const oddTravel = viewportWidth == null ? 0 : Math.max(0, oddRowWidth - viewportWidth);

    const drift = React.useRef(new Animated.Value(0)).current;
    React.useEffect(() => {
        if (reduceMotion) {
            drift.stopAnimation?.();
            drift.setValue(0);
            return;
        }
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(drift, {
                    toValue: 1,
                    duration: 9500,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
                Animated.timing(drift, {
                    toValue: 0,
                    duration: 9500,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
            ]),
        );
        animation.start();
        return () => animation.stop();
    }, [drift, reduceMotion]);

    const driftEven = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -Math.min(24, evenTravel)] });
    const driftOdd = drift.interpolate({ inputRange: [0, 1], outputRange: [-Math.min(24, oddTravel), 0] });

    return (
        <View testID={props.testID} style={styles.root}>
            <Text style={styles.label}>{t('setupOnboarding.providersShowcaseLabel')}</Text>
            <View
                style={styles.showcaseFrame}
                onLayout={(event) => {
                    const nextWidth = Math.round(event.nativeEvent.layout.width);
                    setViewportWidth((prev) => (prev === nextWidth ? prev : nextWidth));
                }}
            >
                <View style={styles.rowViewport}>
                    <Animated.View style={[styles.rowTrack, { transform: [{ translateX: driftEven }] }]}>
                        {evenAgentIds.map((agentId, index) => (
                            <View
                                key={agentId}
                                testID={props.testIDPrefix ? `${props.testIDPrefix}-provider:${agentId}` : undefined}
                                style={[styles.cell, { opacity: 0.78 + ((index % 3) * 0.07) }]}
                            >
                                <AgentIcon agentId={agentId} size={24} />
                            </View>
                        ))}
                    </Animated.View>
                </View>
                <View style={styles.rowViewport}>
                    <Animated.View style={[styles.rowTrack, { transform: [{ translateX: driftOdd }] }]}>
                        {oddAgentIds.map((agentId, index) => (
                            <View
                                key={agentId}
                                testID={props.testIDPrefix ? `${props.testIDPrefix}-provider:${agentId}` : undefined}
                                style={[styles.cell, { opacity: 0.72 + ((index % 3) * 0.07) }]}
                            >
                                <AgentIcon agentId={agentId} size={24} />
                            </View>
                        ))}
                    </Animated.View>
                </View>
            </View>
        </View>
    );
});
