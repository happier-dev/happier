import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { journeyReelItems, type JourneyReelItem } from './reelItems';

export type ShowcaseReelProps = Readonly<{
    items?: readonly JourneyReelItem[];
    activeIndex?: number;
    autoAdvanceMs?: number;
    onSetUpHappier: () => void;
    testID?: string;
}>;

function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    return Math.max(0, Math.min(index, length - 1));
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        minWidth: 0,
        gap: 18,
    },
    grid: {
        width: '100%',
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    featureCard: {
        minWidth: 116,
        flexGrow: 1,
        flexBasis: '30%',
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    featureCardActive: {
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.selected,
    },
    featureTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 12,
        lineHeight: 16,
    },
    activeFrame: {
        minHeight: 128,
        width: '100%',
    },
    activeCard: {
        width: '100%',
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
        padding: 16,
    },
    activeTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 20,
        lineHeight: 26,
    },
    activeBody: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    setupButton: {
        alignSelf: 'flex-start',
        borderRadius: 8,
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    setupButtonPressed: {
        opacity: 0.86,
    },
    setupButtonText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        lineHeight: 18,
    },
}));

export function ShowcaseReel(props: ShowcaseReelProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'journey-reel';
    const items = props.items ?? journeyReelItems;
    const [autoIndex, setAutoIndex] = React.useState(0);
    const activeIndex = clampIndex(props.activeIndex ?? autoIndex, items.length);
    const activeItem = items[activeIndex] ?? null;
    const autoAdvanceMs = props.autoAdvanceMs ?? 1400;

    React.useEffect(() => {
        if (props.activeIndex != null || autoAdvanceMs <= 0 || items.length <= 1) return undefined;

        const interval = setInterval(() => {
            setAutoIndex((current) => (current + 1) % items.length);
        }, autoAdvanceMs);

        return () => {
            clearInterval(interval);
        };
    }, [autoAdvanceMs, items.length, props.activeIndex]);

    return (
        <View testID={testID} style={styles.root}>
            <View testID={`${testID}-grid`} style={styles.grid}>
                {items.map((item, index) => (
                    <View
                        key={item.id}
                        testID={`${testID}-feature-card`}
                        style={[
                            styles.featureCard,
                            index === activeIndex ? styles.featureCardActive : null,
                        ]}
                    >
                        <Text
                            numberOfLines={2}
                            style={styles.featureTitle}
                        >
                            {t(item.titleKey)}
                        </Text>
                    </View>
                ))}
            </View>
            <View testID={`${testID}-active-frame`} style={styles.activeFrame}>
                {activeItem ? (
                    <SlideTransitionSwitch
                        contentKey={activeItem.id}
                        direction="replace"
                        preset="soft"
                        blur
                        testID={`${testID}-active-transition`}
                    >
                        <View testID={`${testID}-active-card`} style={styles.activeCard}>
                            <Text style={styles.activeTitle}>
                                {t(activeItem.titleKey)}
                            </Text>
                            <Text style={styles.activeBody}>
                                {t(activeItem.bodyKey)}
                            </Text>
                        </View>
                    </SlideTransitionSwitch>
                ) : null}
            </View>
            <Pressable
                testID={`${testID}-setup`}
                accessibilityRole="button"
                onPress={props.onSetUpHappier}
                style={({ pressed }) => [
                    styles.setupButton,
                    pressed ? styles.setupButtonPressed : null,
                ]}
            >
                <Text style={styles.setupButtonText}>
                    {t('journey.reel.setUpHappier')}
                </Text>
            </Pressable>
        </View>
    );
}
