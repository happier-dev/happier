import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useNewSessionEmbeddedHost } from '@/components/sessions/new/navigation/newSessionHost';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { INSTRUMENT_STRIP_LINE_HEIGHT_PX } from '@/components/sessions/agentInput/instrumentStrip/instrumentStripStyles';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const COMPACT_ACTIONS_MAX_WIDTH = 560;

/**
 * The actions stand in the composer's status row, so they draw at its line height: a taller action grew the
 * row and moved the card when a draft's actions appeared. A finger reaches them through the hit area.
 */
export const NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE = INSTRUMENT_STRIP_LINE_HEIGHT_PX;
/** Half the row's 4 px gap: neighbouring actions' hit areas meet, never overlap. */
const ACTION_HIT_REACH = { left: 2, right: 2 } as const;
/** Every glyph in the status row's actions, labelled or not, is the composer's quiet icon glyph. */
const ACTION_GLYPH_SIZE = resolveIconButtonGlyphSize(AGENT_INPUT_QUIET_ICON_SIZE_PX);

export const NewSessionDraftComposerActions = React.memo(function NewSessionDraftComposerActions(props: Readonly<{
    deleteDisabled: boolean;
    onStartAnother: () => void;
    onDelete: () => Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < COMPACT_ACTIONS_MAX_WIDTH;
    // Docked on a desktop, the card is narrow and its status row carries the machine line too: the
    // actions are quiet icons there (owner 2026-11-01), named by their tooltip and accessible name.
    const icons = useNewSessionEmbeddedHost()?.kind === 'docked' && !isMobileLayoutWidth(width);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const deleteItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => [{
        id: 'delete',
        testID: 'new-session-draft-delete',
        title: t('sessionDrafts.delete.action'),
        disabled: props.deleteDisabled,
        icon: <Icon name="trash" size={ACTION_GLYPH_SIZE} color={theme.colors.state.danger.foreground} />,
    }], [props.deleteDisabled, theme.colors.state.danger.foreground]);

    const runDelete = React.useCallback(() => {
        fireAndForget(props.onDelete(), { tag: 'NewSessionDraftComposerActions.delete' });
    }, [props.onDelete]);

    // Unwrapped, so they are the status row's own items: every icon in the row takes the row's one gap.
    if (icons) {
        return (
            <>
                <IconButton testID="new-session-draft-start-another" variant="plain" iconName="plus" size={AGENT_INPUT_QUIET_ICON_SIZE_PX}
                    accessibilityLabel={t('sessionDrafts.startAnother')} tooltip={t('sessionDrafts.startAnother')} tooltipPlacement="top"
                    onPress={props.onStartAnother} />
                <IconButton testID="new-session-draft-delete" variant="plain" iconName="trash" size={AGENT_INPUT_QUIET_ICON_SIZE_PX}
                    accessibilityLabel={t('sessionDrafts.delete.action')} tooltip={t('sessionDrafts.delete.action')} tooltipPlacement="top"
                    disabled={props.deleteDisabled} onPress={runDelete} />
            </>
        );
    }

    return (
        <View style={styles.root}>
            <HappierPressable
                hitReach={ACTION_HIT_REACH}
                testID="new-session-draft-start-another"
                accessibilityRole="button"
                accessibilityLabel={t('sessionDrafts.startAnother')}
                onPress={props.onStartAnother}
                style={styles.labeledAction}
            >
                <Icon name="plus" size={ACTION_GLYPH_SIZE} color={theme.colors.text.secondary} />
                <Text variant="body" style={styles.secondaryLabel} numberOfLines={1}>
                    {t('sessionDrafts.startAnother')}
                </Text>
            </HappierPressable>
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
                        <IconButton testID="new-session-draft-actions-menu" variant="plain" iconName="dots-three" size={AGENT_INPUT_QUIET_ICON_SIZE_PX}
                            accessibilityLabel={t('common.moreActions')} onPress={toggle} />
                    )}
                />
            ) : (
                <HappierPressable
                hitReach={ACTION_HIT_REACH}
                    testID="new-session-draft-delete"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionDrafts.delete.action')}
                    disabled={props.deleteDisabled}
                    onPress={runDelete}
                    style={[styles.labeledAction, props.deleteDisabled && styles.disabled]}
                >
                    <Icon name="trash" size={ACTION_GLYPH_SIZE} color={theme.colors.text.tertiary} />
                    <Text variant="body" style={styles.deleteLabel} numberOfLines={1}>
                        {t('sessionDrafts.delete.action')}
                    </Text>
                </HappierPressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s4,
    },
    labeledAction: {
        alignItems: 'center',
        borderRadius: 8,
        flexDirection: 'row',
        gap: theme.space.s4,
        minHeight: NEW_SESSION_DRAFT_COMPOSER_ACTION_SIZE,
        paddingHorizontal: theme.space.s8,
    },
    secondaryLabel: {
        color: theme.colors.text.secondary,
    },
    deleteLabel: {
        color: theme.colors.text.tertiary,
    },
    disabled: {
        opacity: 0.4,
    },
}));
