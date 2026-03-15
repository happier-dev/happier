import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type ToolTimelineRowDensity = 'comfortable' | 'compact';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export type ToolTimelineRowHeaderDisclosure =
    | { behavior: 'hover'; state: 'collapsed' | 'expanded' }
    | { behavior: 'persistent'; state: 'collapsed' | 'expanded' };

export const ToolTimelineRowHeader = React.memo(function ToolTimelineRowHeader(props: {
    testID?: string;
    density: ToolTimelineRowDensity;
    icon: React.ReactNode;
    title: string;
    subtitle?: string | null;
    statusText?: string | null;
    onPress?: (() => void) | null;
    canOpen?: boolean;
    onOpen?: (() => void) | null;
    rightElement?: React.ReactNode | null;
    disclosure?: ToolTimelineRowHeaderDisclosure | null;
}) {
    const { theme } = useUnistyles();

    const showSubtitleInline = Boolean(props.subtitle && String(props.subtitle).trim().length > 0);
    const showStatusInline = Boolean(props.statusText && String(props.statusText).trim().length > 0);
    const canOpen = props.canOpen === true && typeof props.onOpen === 'function';
    const disclosure = props.disclosure ?? null;
    const hoverEnabled = Platform.OS === 'web' && disclosure?.behavior === 'hover' && Boolean(props.onPress);
    const [isHovered, setIsHovered] = React.useState(false);

    const handleHoverIn = React.useCallback(() => setIsHovered(true), []);
    const handleHoverOut = React.useCallback(() => setIsHovered(false), []);

    const chevronSize = props.density === 'compact' ? 16 : 18;
    const disclosureChevronName: IoniconName | null =
        disclosure?.state === 'expanded' ? 'chevron-up' : disclosure?.state === 'collapsed' ? 'chevron-down' : null;

    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress ?? undefined}
            disabled={!props.onPress}
            onHoverIn={hoverEnabled ? handleHoverIn : undefined}
            onHoverOut={hoverEnabled ? handleHoverOut : undefined}
            style={({ pressed }) => [
                styles.row,
                props.density === 'compact' ? styles.rowCompact : null,
                pressed && styles.rowPressed,
            ]}
        >
            <View style={styles.icon}>
                {disclosure?.behavior === 'persistent' && disclosureChevronName ? (
                    <Ionicons name={disclosureChevronName} size={chevronSize} color={theme.colors.textSecondary} />
                ) : hoverEnabled && disclosureChevronName ? (
                    <View style={styles.iconStack}>
                        <View
                            style={[
                                styles.iconLayer,
                                Platform.OS === 'web' ? styles.iconLayerTransition : null,
                                isHovered ? styles.iconLayerHidden : null,
                            ]}
                        >
                            {props.icon}
                        </View>
                        <View
                            style={[
                                styles.iconLayer,
                                styles.iconLayerOverlay,
                                Platform.OS === 'web' ? styles.iconLayerTransition : null,
                                isHovered ? null : styles.iconLayerHidden,
                            ]}
                        >
                            <Ionicons
                                name={disclosureChevronName}
                                size={chevronSize}
                                color={theme.colors.textSecondary}
                            />
                        </View>
                    </View>
                ) : (
                    props.icon
                )}
            </View>
            <View style={styles.text}>
                <Text
                    style={[styles.title, props.density === 'compact' ? styles.titleCompact : null]}
                    numberOfLines={1}
                >
                    {props.title}
                    {showSubtitleInline ? (
                        <Text style={styles.subtitleInline} numberOfLines={1}>
                            {` — ${props.subtitle}`}
                        </Text>
                    ) : null}
                    {showStatusInline ? (
                        <Text style={styles.statusInline} numberOfLines={1}>
                            {` · ${props.statusText}`}
                        </Text>
                    ) : null}
                </Text>
            </View>
            {props.rightElement ? <View style={styles.actions}>{props.rightElement}</View> : null}
            {canOpen ? (
                <Pressable
                    onPress={props.onOpen ?? undefined}
                    accessibilityRole="button"
                    accessibilityLabel={t('toolView.open')}
                    style={({ pressed }) => [styles.open, pressed && styles.openPressed]}
                >
                    <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            ) : null}
        </Pressable>
    );
});

const styles = StyleSheet.create((theme, _runtime) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 0,
        paddingVertical: 0,
        gap: 6,
        borderRadius: 10,
        minHeight: 30,
    },
    rowCompact: {
        minHeight: 28,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    icon: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconStack: {
        position: 'relative',
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconLayer: {
        opacity: 1,
    },
    iconLayerOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconLayerTransition: {
        transitionProperty: 'opacity',
        transitionDuration: '140ms',
        transitionTimingFunction: 'ease',
    },
    iconLayerHidden: {
        opacity: 0,
    },
    text: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
        color: theme.colors.text,
    },
    titleCompact: {
        fontSize: 13,
        lineHeight: 18,
    },
    subtitleInline: {
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    statusInline: {
        fontWeight: '500',
        opacity: 0.4,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    open: {
        padding: 4,
        borderRadius: 10,
    },
    openPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
}));
