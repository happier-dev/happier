import * as React from 'react';
import { Animated, StyleSheet as NativeStyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/** A retained, geometry-free tint; its lifetime is the revision owner's, not a timer. */
export function WorkflowAgentChangeTint(props: Readonly<{ blockId: string }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const opacity = React.useRef(new Animated.Value(reducedMotion ? 0.12 : 0)).current;
    React.useEffect(() => {
        if (reducedMotion) { opacity.setValue(0.12); return; }
        const animation = Animated.timing(opacity, { toValue: 0.12, duration: motionTokens.durationMs.fast, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [opacity, reducedMotion]);
    return <Animated.View
        testID={`workflow-agent-change:${props.blockId}`}
        accessibilityLabel={t('workflows.authoring.changedByAgent')}
        pointerEvents="none"
        style={[NativeStyleSheet.absoluteFillObject, { opacity, backgroundColor: theme.colors.text.primary }]} />;
}
