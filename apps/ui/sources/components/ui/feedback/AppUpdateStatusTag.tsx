import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useAppUpdateStatus } from '@/updates/useAppUpdateStatus';

import { AppUpdateStatusPopover } from './AppUpdateStatusPopover';

export type AppUpdateStatusTagProps = Readonly<{
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    tag: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    tagPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    label: {
        fontSize: 12,
        fontWeight: '600',
    },
}));

export function AppUpdateStatusTag(props: AppUpdateStatusTagProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { model, runPrimaryAction, dismiss } = useAppUpdateStatus();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);

    if (!model.visible) {
        return null;
    }

    const toneColor =
        model.tone === 'success'
            ? theme.colors.success
            : model.tone === 'warning'
                ? theme.colors.warningCritical
                : theme.colors.accent.indigo;

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID={props.testID ?? 'app-update-status-tag'}
                onPress={() => setOpen((value) => !value)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => [styles.tag, pressed ? styles.tagPressed : null]}
            >
                <Ionicons name={model.iconName} size={14} color={toneColor} />
                <Text style={[styles.label, { color: toneColor }]} numberOfLines={1}>
                    {model.label}
                </Text>
            </Pressable>
            <AppUpdateStatusPopover
                anchorRef={anchorRef}
                model={model}
                onPrimaryAction={async () => {
                    await runPrimaryAction();
                    setOpen(false);
                }}
                onDismiss={model.dismissLabel ? () => {
                    dismiss();
                    setOpen(false);
                } : undefined}
                onRequestClose={() => setOpen(false)}
                open={open}
                testID="app-update-status-popover"
            />
        </>
    );
}
