import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useAppUpdateStatus } from '@/updates/useAppUpdateStatus';

import { AppUpdateStatusPopover } from './AppUpdateStatusPopover';

export type AppUpdateStatusTagProps = Readonly<{
    fallback?: React.ReactNode;
    labelVariant?: 'full' | 'short';
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    tag: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    tagPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    label: {
        fontSize: 12,
        fontWeight: '600',
    },
}));

function resolveToneColor(theme: any, tone: 'success' | 'warning' | 'accent'): string {
    if (tone === 'success') {
        return theme.colors.state.success.foreground;
    }
    if (tone === 'warning') {
        return theme.colors.state.danger.foreground;
    }
    return theme.colors.accent.indigo;
}

export function AppUpdateStatusTag(props: AppUpdateStatusTagProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { model, runPrimaryAction, dismiss } = useAppUpdateStatus();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<any>(null);

    if (!model.visible) {
        return props.fallback ? <>{props.fallback}</> : null;
    }

    const toneColor = resolveToneColor(theme, model.tone);

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
                    {props.labelVariant === 'short' ? t('updateBanner.updateShort') : model.label}
                </Text>
            </Pressable>
            {open ? (
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
            ) : null}
        </>
    );
}
