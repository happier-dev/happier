import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useHappierItemGroupItemBehavior } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WizardIconBox } from './WizardIconBox';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

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
    onPress: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 11,
        lineHeight: 14,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    retryButton: {
        minWidth: 0,
    },
    menuTrigger: {
        paddingHorizontal: 6,
        paddingVertical: 6,
    },
}));

export const WizardChoiceRow = React.memo(function WizardChoiceRow(props: WizardChoiceRowProps) {
    const { theme } = useUnistyles();
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
        props.onPress();
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
            containerStyle={props.dimmed ? ({ opacity: 0.55 } as const) : null}
            left={<WizardIconBox icon={props.icon} selected={props.selected} boxSize={32} iconSize={18} />}
            title={props.title}
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
                                <Pressable
                                    testID={`${props.testID}-menu`}
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                    onPress={toggle}
                                    style={({ pressed }) => ([
                                        styles.menuTrigger,
                                        { opacity: pressed ? 0.72 : 1 },
                                        Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : null,
                                    ])}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.more')}
                                >
                                    <Icon name="dots-three" size={16} color={theme.colors.text.secondary} />
                                </Pressable>
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
