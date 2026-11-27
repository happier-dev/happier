import * as React from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

export type StarAskPresentation =
    | { kind: 'supporter_prompt' }
    | { kind: 'star'; count: number | null; login?: string };

export function StarAskCard(props: Readonly<{
    presentation: StarAskPresentation;
    state: 'ready' | 'pending' | 'web' | 'done';
    primary: () => void;
    dismiss: () => void;
    onThanksFinished: () => void;
}>) {
    const { theme } = useUnistyles();
    const supporter = props.presentation.kind === 'supporter_prompt';
    const who = props.presentation.kind === 'star' && props.state !== 'web' ? props.presentation.login : undefined;
    const count = props.presentation.kind === 'star' ? props.presentation.count : null;
    if (props.state === 'done') return <StarAskThanks count={count} onFinished={props.onThanksFinished} />;
    return (
        <View style={styles.card} testID="session-supporter-ask" role="status" accessibilityLiveRegion="polite">
            <View style={styles.header}>
                <Icon name={supporter ? 'heart' : 'star'} size={17} color={theme.colors.supporter.accent} />
                <Text style={styles.title}>
                    {t(supporter ? 'supporterAsk.supportTitle' : 'supporterAsk.starTitle')}
                </Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={8} style={styles.close} onPress={props.dismiss}>
                    <Icon name="x" size={20} color={theme.colors.text.secondary} />
                </Pressable>
            </View>
            <Text style={styles.body}>{t(supporter ? 'supporterAsk.supportBody' : 'supporterAsk.starBody')}</Text>
            {who ? <Text style={styles.body}>{t('supporterAsk.starringAs', { login: who })}</Text> : null}
            <View style={styles.actions}>
                <RoundButton size="small" title={t('supporterAsk.notNow')} display="inverted" onPress={props.dismiss} />
                <RoundButton
                    size="small"
                    title={supporter ? t('supporterAsk.supportAction')
                        : props.state === 'pending' ? t('supporterAsk.starring')
                        : props.state === 'web' || !who ? t('supporterAsk.openGithub')
                        : count === null ? t('supporterAsk.star') : t('supporterAsk.starWithCount', { count: count.toLocaleString() })}
                    onPress={props.primary}
                    leading={props.state === 'pending' ? <ActivityIndicator size="small" /> : undefined}
                    disabled={props.state === 'pending'}
                />
            </View>
        </View>
    );
}

function StarAskThanks({ count, onFinished }: Readonly<{ count: number | null; onFinished: () => void }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const [fade] = React.useState(() => new Animated.Value(0));
    React.useEffect(() => {
        const animation = Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: Platform.OS !== 'web' });
        const hold = setTimeout(() => {
            if (reducedMotion) onFinished();
            else animation.start(({ finished }) => { if (finished) onFinished(); });
        }, 2600);
        return () => {
            clearTimeout(hold);
            animation.stop();
        };
    }, [fade, onFinished, reducedMotion]);
    const motion = reducedMotion ? undefined : {
        opacity: fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [0, 4] }) }],
    };
    const thanks = t('supporterAsk.thankYou');
    return (
        <Animated.View style={[styles.thanks, motion]} pointerEvents="none" role="status" accessibilityLiveRegion="polite">
            <Icon name="star" size={15} color={theme.colors.supporter.accent} />
            <Text style={styles.title}>{count === null ? thanks : `${(count + 1).toLocaleString()} · ${thanks}`}</Text>
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        padding: 12,
        gap: 6,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.supporter.tint,
        backgroundColor: theme.colors.surface.base,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    close: { marginLeft: 'auto', width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    title: { color: theme.colors.text.primary, fontWeight: '600', flexShrink: 1 },
    body: { color: theme.colors.text.secondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
    thanks: {
        alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
        backgroundColor: theme.colors.surface.base, borderColor: theme.colors.supporter.tint, borderWidth: 1,
    },
}));
