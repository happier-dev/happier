import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useHappierItemGroupItemBehavior } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

type WizardChoiceRowProps = Readonly<{
    testID: string;
    selected: boolean;
    disabled?: boolean;
    dimmed?: boolean;
    accessibilityRole?: 'radio';
    itemGroupRadioIndex?: number;
    icon: IconName;
    title: string;
    subtitle: string;
    badge?: string;
    secondaryAction?: Readonly<{
        testID: string;
        title: string;
        onPress: () => void;
    }>;
    menuActions?: ReadonlyArray<Readonly<{
        id: string;
        title: string;
        destructive?: boolean;
        disabled?: boolean;
        onPress: () => void;
    }>>;
    onPress: () => void | Promise<void>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s2,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('micro'),
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    retryButton: {
        minWidth: 0,
    },
    menuTrigger: {
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s6,
    },
    row: {
        marginHorizontal: 0,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.base,
    },
    titleIcon: {
        transform: [{ translateY: 1.5 }],
    },
}));

export const WizardChoiceRow = React.memo(function WizardChoiceRow(props: WizardChoiceRowProps) {
    const { theme } = useUnistyles();
    const menuTriggerFeedback = usePressFeedback({ glyph: true });
    const styles = stylesheet;
    const iconColor = props.selected ? theme.colors.text.primary : theme.colors.text.secondary;
    const rowDisabled = Boolean(props.disabled);
    const isWeb = Platform.OS === 'web';
    const [menuOpen, setMenuOpen] = React.useState(false);
    const groupItem = useHappierItemGroupItemBehavior({
        role: props.accessibilityRole,
        itemGroupRadioIndex: props.itemGroupRadioIndex,
        disabled: rowDisabled,
    });

    const onPress = React.useCallback(() => {
        if (rowDisabled) return;
        return props.onPress();
    }, [props.onPress, rowDisabled]);
    const onKeyDown = React.useCallback((event: unknown) => {
        if (!isWeb || !event || typeof event !== 'object') return;
        const keyboardEvent = event as Readonly<{
            key?: unknown;
            nativeEvent?: Readonly<{ key?: unknown }>;
            preventDefault?: () => void;
            stopPropagation?: () => void;
        }>;
        const key = typeof keyboardEvent.nativeEvent?.key === 'string'
            ? keyboardEvent.nativeEvent.key
            : typeof keyboardEvent.key === 'string'
                ? keyboardEvent.key
                : null;
        if (!key || !groupItem.onKeyDown(key)) return;
        keyboardEvent.preventDefault?.();
        keyboardEvent.stopPropagation?.();
    }, [groupItem, isWeb]);

    const badgeNode = props.badge ? (
        <View style={styles.badge}>
            <Text style={styles.badgeText}>{props.badge}</Text>
        </View>
    ) : null;

    const menuActions = props.menuActions ?? [];
    const menuItems = React.useMemo(() => {
        return menuActions.map((action) => ({
            id: action.id,
            title: action.title,
            disabled: action.disabled,
        }));
    }, [menuActions]);

    const hasInteractiveTrailingContent = Boolean(props.secondaryAction) || menuActions.length > 0;

    return (
        <SelectableRow
            ref={groupItem.grouped ? groupItem.targetRef : undefined}
            testID={props.testID}
            variant="selectable"
            selected={props.selected}
            disabled={rowDisabled}
            accessibilityRole={props.accessibilityRole}
            tabIndex={isWeb && groupItem.grouped
                ? groupItem.tabStopIndex === props.itemGroupRadioIndex ? 0 : -1
                : undefined}
            onKeyDown={onKeyDown}
            onPress={onPress}
            containerStyle={[
                styles.row,
                props.selected ? styles.rowSelected : null,
                props.dimmed ? ({ opacity: 0.55 } as const) : null,
            ]}
            title={props.title}
            titleLeading={(
                <View testID={`${props.testID}-title-icon`} style={styles.titleIcon}>
                    <Icon name={props.icon} size={18} color={iconColor} />
                </View>
            )}
            titleAccessory={badgeNode}
            titleStyle={badgeNode ? ({ flexGrow: 0, flexShrink: 1 } as const) : null}
            subtitle={props.subtitle}
            rightElementOutsidePressable={hasInteractiveTrailingContent}
            right={(
                <View style={styles.trailing}>
                    {props.secondaryAction ? (
                        <RoundButton
                            testID={props.secondaryAction.testID}
                            size="small"
                            display="inverted"
                            style={styles.retryButton}
                            title={props.secondaryAction.title}
                            onPress={() => {
                                props.secondaryAction?.onPress();
                            }}
                        />
                    ) : null}
                    {menuItems.length > 0 ? (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={(itemId) => {
                                const selectedAction = menuActions.find((action) => action.id === itemId);
                                selectedAction?.onPress();
                                setMenuOpen(false);
                            }}
                            placement="left"
                            matchTriggerWidth={false}
                            variant="slim"
                            trigger={({ toggle }) => (
                                <HappierPressable
                                    testID={`${props.testID}-menu`}
                                    onPress={toggle}
                                    onPressIn={menuTriggerFeedback.onPressIn}
                                    onPressOut={menuTriggerFeedback.onPressOut}
                                    style={[
                                        styles.menuTrigger,
                                        Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : null,
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.more')}
                                >
                                    <Animated.View style={menuTriggerFeedback.animatedStyle}>
                                        <Icon name="dots-three" size={16} color={theme.colors.text.secondary} />
                                    </Animated.View>
                                </HappierPressable>
                            )}
                        />
                    ) : null}
                    <Icon
                        name={props.selected ? 'check-circle' : 'circle'}
                        size={16}
                        color={iconColor}
                    />
                </View>
            )}
        />
    );
});
