import * as React from 'react';
import { View, StyleProp, ViewStyle, TextStyle, Platform, I18nManager, type ViewProps } from 'react-native';
import { shadowLevelStyle } from '@/shadowElevation';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { withItemGroupDividers } from './ItemGroup.dividers';
import { countSelectableItems } from './ItemGroup.selectableCount';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX,
} from './itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';


export { withItemGroupDividers } from './ItemGroup.dividers';

export type ItemGroupRadioFocusable = Readonly<{ focus?: () => void }>;

type ItemGroupRadioContext = Readonly<{
    tabStopIndex: number | null;
    register: (index: number, target: ItemGroupRadioFocusable | null) => () => void;
    move: (index: number, key: string) => boolean;
}>;

export const ItemGroupSelectionContext = React.createContext<Readonly<{
    selectableItemCount: number;
    radioGroup?: ItemGroupRadioContext | null;
}> | null>(null);

type ItemGroupRadioChildProps = Readonly<{
    accessibilityRole?: ViewProps['accessibilityRole'];
    webRole?: ViewProps['role'];
    selected?: boolean;
    disabled?: boolean;
    loading?: boolean;
    onPress?: () => void;
    itemGroupRadioIndex?: number;
}>;

type ItemGroupRadioEntry = Readonly<{
    disabled: boolean;
    onPress: (() => void) | null;
    selected: boolean;
}>;

function projectItemGroupRadioChildren(
    children: React.ReactNode,
    enabled: boolean,
): Readonly<{
    children: React.ReactNode;
    entries: readonly ItemGroupRadioEntry[];
}> {
    if (!enabled) return { children, entries: [] };

    const entries: ItemGroupRadioEntry[] = [];
    const project = (node: React.ReactNode): React.ReactNode => React.Children.map(node, (child) => {
        if (!React.isValidElement(child)) return child;
        if (child.type === React.Fragment) {
            const fragment = child as React.ReactElement<{ children?: React.ReactNode }>;
            return React.cloneElement(fragment, {}, project(fragment.props.children));
        }

        const element = child as React.ReactElement<ItemGroupRadioChildProps>;
        const isRadio = element.props.accessibilityRole === 'radio' || element.props.webRole === 'radio';
        if (!isRadio) return child;

        const itemGroupRadioIndex = entries.length;
        const onPress = typeof element.props.onPress === 'function' ? element.props.onPress : null;
        entries.push({
            disabled: element.props.disabled === true || element.props.loading === true || onPress === null,
            onPress,
            selected: element.props.selected === true,
        });
        return React.cloneElement(element, { itemGroupRadioIndex });
    });

    return { children: project(children), entries };
}

export interface ItemGroupProps {
    title?: string | React.ReactNode;
    footer?: string;
    children: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    footerTextStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    constrainToContentWidth?: boolean;
    /**
     * Performance: when you already know how many selectable rows are inside the group,
     * pass this to avoid walking the full React children tree on every render.
     */
    selectableItemCountOverride?: number;
}

const stylesheet = StyleSheet.create((theme) => {
    const surfaceChromeStyle = resolveThemeSurfaceChromeStyle({
        borderColor: theme.colors.border.surface,
        highlightColor: theme.colors.effect.surfaceHighlight,
        shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[1]),
    });

    return {
        wrapper: {
            alignItems: 'center',
        },
        container: {
            width: '100%',
            paddingHorizontal: Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX),
        },
        header: {
            paddingTop: Platform.select({ ios: 26, default: 20 }),
            paddingBottom: Platform.select({ ios: 8, default: 8 }),
            paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        },
        headerNoTitle: {
            paddingTop: Platform.select({ ios: 20, default: 16 }),
        },
        headerText: {
            ...Typography.default('regular'),
            color: theme.colors.text.secondary,
            fontSize: Platform.select({ ios: 13, default: 14 }),
            lineHeight: Platform.select({ ios: 18, default: 20 }),
            letterSpacing: -0.08,
            textTransform: 'uppercase'
        },
        contentContainerOuter: {
            backgroundColor: theme.colors.surface.base,
            marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
            borderRadius: Platform.select({ ios: 10, default: 16 }),
            ...surfaceChromeStyle,
            // IMPORTANT: allow popovers to overflow this rounded container.
            overflow: 'visible',
        },
        contentContainerInner: {
            borderRadius: Platform.select({ ios: 10, default: 16 }),
        },
        footer: {
            paddingTop: Platform.select({ ios: 6, default: 8 }),
            paddingBottom: Platform.select({ ios: 8, default: 16 }),
            paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        },
        footerText: {
            ...Typography.default('regular'),
            color: theme.colors.text.secondary,
            fontSize: Platform.select({ ios: 13, default: 14 }),
            lineHeight: Platform.select({ ios: 18, default: 20 }),
            letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
        },
    };
});

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const maxWidth = useLayoutMaxWidth();

    const {
        title,
        footer,
        children,
        accessibilityRole,
        accessibilityLabel,
        style,
        headerStyle,
        footerStyle,
        titleStyle,
        footerTextStyle,
        containerStyle,
        constrainToContentWidth = true,
        selectableItemCountOverride
    } = props;

    if (
        accessibilityRole === 'radiogroup'
        && (typeof accessibilityLabel !== 'string' || accessibilityLabel.trim().length === 0)
    ) {
        throw new Error('ItemGroup radiogroup requires a non-empty accessible name');
    }

    const selectableItemCount = React.useMemo(() => {
        if (typeof selectableItemCountOverride === 'number') {
            return selectableItemCountOverride;
        }
        return countSelectableItems(children);
    }, [children, selectableItemCountOverride]);

    const radioProjection = React.useMemo(
        () => projectItemGroupRadioChildren(children, accessibilityRole === 'radiogroup'),
        [accessibilityRole, children],
    );
    const radioTargetsRef = React.useRef(new Map<number, ItemGroupRadioFocusable>());
    const registerRadioTarget = React.useCallback((index: number, target: ItemGroupRadioFocusable | null) => {
        if (target) {
            radioTargetsRef.current.set(index, target);
        } else {
            radioTargetsRef.current.delete(index);
        }
        return () => {
            if (radioTargetsRef.current.get(index) === target) {
                radioTargetsRef.current.delete(index);
            }
        };
    }, []);
    const radioTabStopIndex = React.useMemo(() => {
        const selectedIndex = radioProjection.entries.findIndex((entry) => entry.selected && !entry.disabled);
        if (selectedIndex >= 0) return selectedIndex;
        const firstEnabledIndex = radioProjection.entries.findIndex((entry) => !entry.disabled);
        return firstEnabledIndex >= 0 ? firstEnabledIndex : null;
    }, [radioProjection.entries]);
    const moveRadioFocus = React.useCallback((index: number, key: string): boolean => {
        const enabledIndexes = radioProjection.entries
            .map((entry, entryIndex) => entry.disabled ? -1 : entryIndex)
            .filter((entryIndex) => entryIndex >= 0);
        const currentPosition = enabledIndexes.indexOf(index);
        if (currentPosition < 0 || enabledIndexes.length === 0) return false;

        let nextPosition: number;
        if (key === 'Home') {
            nextPosition = 0;
        } else if (key === 'End') {
            nextPosition = enabledIndexes.length - 1;
        } else {
            const step = key === 'ArrowDown'
                ? 1
                : key === 'ArrowUp'
                    ? -1
                    : key === 'ArrowRight'
                        ? I18nManager.isRTL ? -1 : 1
                        : key === 'ArrowLeft'
                            ? I18nManager.isRTL ? 1 : -1
                            : 0;
            if (step === 0) return false;
            nextPosition = (currentPosition + step + enabledIndexes.length) % enabledIndexes.length;
        }

        const nextIndex = enabledIndexes[nextPosition];
        if (nextIndex === undefined) return false;
        radioProjection.entries[nextIndex]?.onPress?.();
        radioTargetsRef.current.get(nextIndex)?.focus?.();
        return true;
    }, [radioProjection.entries]);

    const selectionContextValue = React.useMemo(() => {
        return {
            selectableItemCount,
            radioGroup: accessibilityRole === 'radiogroup'
                ? {
                    tabStopIndex: radioTabStopIndex,
                    register: registerRadioTarget,
                    move: moveRadioFocus,
                }
                : null,
        };
    }, [
        accessibilityRole,
        moveRadioFocus,
        radioTabStopIndex,
        registerRadioTarget,
        selectableItemCount,
    ]);

    return (
        <View style={[styles.wrapper, style]}>
            <View style={[styles.container, constrainToContentWidth ? { maxWidth } : undefined]}>
                {/* Header */}
                {title ? (
                    <View style={[styles.header, headerStyle]}>
                        {typeof title === 'string' ? (
                            <Eyebrow style={[styles.headerText, titleStyle]}>
                                {title}
                            </Eyebrow>
                        ) : (
                            title
                        )}
                    </View>
                ) : (
                    // Add top margin when there's no title
                    <View style={styles.headerNoTitle} />
                )}

                {/* Content Container */}
                <View
                    accessibilityRole={Platform.OS === 'web' ? undefined : accessibilityRole}
                    accessibilityLabel={accessibilityLabel}
                    aria-label={Platform.OS === 'web' ? accessibilityLabel : undefined}
                    role={Platform.OS === 'web' ? accessibilityRole : undefined}
                    style={[styles.contentContainerOuter, containerStyle]}
                >
                    <View style={styles.contentContainerInner}>
                        <ItemGroupSelectionContext.Provider value={selectionContextValue}>
                            {withItemGroupDividers(radioProjection.children)}
                        </ItemGroupSelectionContext.Provider>
                    </View>
                </View>

                {/* Footer */}
                {footer && (
                    <View style={[styles.footer, footerStyle]}>
                        <Text style={[styles.footerText, footerTextStyle]}>
                            {footer}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});
