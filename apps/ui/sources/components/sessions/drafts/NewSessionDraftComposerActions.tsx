import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const COMPACT_ACTIONS_MAX_WIDTH = 560;

export const NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE = 44;

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
        <View style={styles.root}>
            <Pressable
                testID="new-session-draft-start-another"
                accessibilityRole="button"
                accessibilityLabel={t('sessionDrafts.startAnother')}
                onPress={props.onStartAnother}
                style={styles.labeledAction}
            >
                <Icon name="plus" size={15} color={theme.colors.text.secondary} />
                <Text style={styles.secondaryLabel} numberOfLines={1}>
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
                            style={styles.iconAction}
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
                    style={[styles.labeledAction, props.deleteDisabled && styles.disabled]}
                >
                    <Icon name="trash" size={15} color={theme.colors.state.danger.foreground} />
                    <Text style={styles.dangerLabel} numberOfLines={1}>
                        {t('sessionDrafts.delete.action')}
                    </Text>
                </Pressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
    },
    labeledAction: {
        alignItems: 'center',
        borderRadius: 8,
        flexDirection: 'row',
        gap: 5,
        minHeight: NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE,
        paddingHorizontal: 8,
    },
    iconAction: {
        alignItems: 'center',
        borderRadius: 8,
        justifyContent: 'center',
        minHeight: NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE,
        minWidth: NEW_SESSION_DRAFT_COMPOSER_ACTION_MIN_SIZE,
    },
    secondaryLabel: {
        color: theme.colors.text.secondary,
    },
    dangerLabel: {
        color: theme.colors.state.danger.foreground,
    },
    disabled: {
        opacity: 0.4,
    },
}));
