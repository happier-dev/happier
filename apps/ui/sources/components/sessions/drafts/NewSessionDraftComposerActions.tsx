import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const COMPACT_ACTIONS_MAX_WIDTH = 560;

export const NewSessionDraftComposerActions = React.memo(function NewSessionDraftComposerActions(props: Readonly<{
    deleteDisabled: boolean;
    onStartAnother: () => void;
    onDelete: () => Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < COMPACT_ACTIONS_MAX_WIDTH;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const deleteItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [{
        id: 'delete',
        testID: 'new-session-draft-delete',
        title: t('sessionDrafts.delete.action'),
        disabled: props.deleteDisabled,
        icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
    }], [props.deleteDisabled, theme.colors.state.danger.foreground]);

    const runDelete = React.useCallback(() => {
        fireAndForget(props.onDelete(), { tag: 'NewSessionDraftComposerActions.delete' });
    }, [props.onDelete]);

    return (
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 4 }}>
            <Pressable
                testID="new-session-draft-start-another"
                accessibilityRole="button"
                accessibilityLabel={t('sessionDrafts.startAnother')}
                onPress={props.onStartAnother}
                hitSlop={{ top: 4, bottom: 4 }}
                style={{
                    alignItems: 'center',
                    borderRadius: 8,
                    flexDirection: 'row',
                    gap: 5,
                    minHeight: 36,
                    paddingHorizontal: 8,
                }}
            >
                <Icon name="plus" size={15} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary }} numberOfLines={1}>
                    {t('sessionDrafts.startAnother')}
                </Text>
            </Pressable>
            {compact ? (
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={deleteItems}
                    onSelect={(itemId) => {
                        if (itemId === 'delete') runDelete();
                    }}
                    placement="left"
                    variant="slim"
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <Pressable
                            testID="new-session-draft-actions-menu"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.moreActions')}
                            onPress={toggle}
                            hitSlop={{ top: 4, bottom: 4 }}
                            style={{
                                alignItems: 'center',
                                borderRadius: 8,
                                justifyContent: 'center',
                                minHeight: 36,
                                minWidth: 36,
                            }}
                        >
                            <Icon name="dots-three" size={17} color={theme.colors.text.secondary} />
                        </Pressable>
                    )}
                />
            ) : (
                <Pressable
                    testID="new-session-draft-delete"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionDrafts.delete.action')}
                    accessibilityState={{ disabled: props.deleteDisabled }}
                    disabled={props.deleteDisabled}
                    onPress={runDelete}
                    hitSlop={{ top: 4, bottom: 4 }}
                    style={{
                        alignItems: 'center',
                        borderRadius: 8,
                        flexDirection: 'row',
                        gap: 5,
                        minHeight: 36,
                        opacity: props.deleteDisabled ? 0.4 : 1,
                        paddingHorizontal: 8,
                    }}
                >
                    <Icon name="trash" size={15} color={theme.colors.state.danger.foreground} />
                    <Text style={{ color: theme.colors.state.danger.foreground }} numberOfLines={1}>
                        {t('sessionDrafts.delete.action')}
                    </Text>
                </Pressable>
            )}
        </View>
    );
});
