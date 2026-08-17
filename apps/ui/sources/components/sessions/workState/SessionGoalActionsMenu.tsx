import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

/**
 * Goal lifecycle actions (Pause/Resume, Complete, Clear) folded into a single `⋯` overflow menu so
 * the goal header cannot wrap unpredictably on narrow widths (U-5). Edit stays inline at the call
 * site — only the secondary/destructive lifecycle actions live here. Menu items keep the canonical
 * `session-goal-*-button` testIDs and fire their handlers synchronously (the menu closes first), so
 * both the UI contract and the popover behavior tests target the same ids.
 *
 * Built on the app's canonical menu primitives (`Popover` + `ActionListSection`), mirroring the
 * changed-files-row `⋯` pattern, rather than a bespoke surface. Ported from remote-dev by intent.
 */

export type SessionGoalMenuAction = Readonly<{
    id: string;
    testID: string;
    label: string;
    icon: IconName;
    destructive?: boolean;
    onPress: () => void;
}>;

export function SessionGoalActionsMenu(props: Readonly<{
    actions: readonly SessionGoalMenuAction[];
    disabled?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);

    if (props.actions.length === 0) return null;

    const items: ActionListItem[] = props.actions.map((action) => ({
        id: action.id,
        testID: action.testID,
        label: action.label,
        icon: (
            <Icon
                name={action.icon}
                size={16}
                color={action.destructive ? theme.colors.state.danger.foreground : theme.colors.button.secondary.tint}
            />
        ),
        onPress: () => {
            setOpen(false);
            action.onPress();
        },
    }));

    return (
        <View ref={anchorRef}>
            <Pressable
                testID="session-goal-actions-overflow"
                accessibilityRole="button"
                accessibilityLabel={t('common.moreActions')}
                accessibilityHint={t('common.moreActionsHint')}
                disabled={props.disabled}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                onPress={() => setOpen((current) => !current)}
                style={styles.trigger}
            >
                <Icon name="dots-three" size={20} color={theme.colors.text.secondary} />
            </Pressable>
            <Popover
                open={open}
                anchorRef={anchorRef}
                placement="left"
                gap={8}
                maxWidthCap={260}
                maxHeightCap={280}
                edgePadding={{ vertical: 8, horizontal: 8 }}
                portal={{
                    web: true,
                    native: true,
                    matchAnchorWidth: false,
                    anchorAlignVertical: 'center',
                }}
                onRequestClose={() => setOpen(false)}
                backdrop={{ effect: 'blur', closeOnPan: true }}
            >
                {({ maxHeight }: { maxHeight: number }) => (
                    <FloatingOverlay
                        maxHeight={maxHeight}
                        keyboardShouldPersistTaps="always"
                        edgeFades={Platform.OS === 'web' ? undefined : { top: true, bottom: true, size: 24 }}
                    >
                        <ActionListSection actions={items} />
                    </FloatingOverlay>
                )}
            </Popover>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    trigger: {
        minHeight: 34,
        minWidth: 34,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
