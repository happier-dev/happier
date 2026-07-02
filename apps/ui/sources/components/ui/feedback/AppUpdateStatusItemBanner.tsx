import * as React from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useAppUpdateStatus } from '@/updates/useAppUpdateStatus';

function resolveToneColor(
    theme: ReturnType<typeof useUnistyles>['theme'],
    tone: 'success' | 'warning' | 'accent',
): string {
    if (tone === 'success') {
        return theme.colors.state.success.foreground;
    }
    if (tone === 'warning') {
        return theme.colors.state.warning.foreground;
    }
    return theme.colors.accent.indigo;
}

export type AppUpdateStatusItemBannerProps = Readonly<{
    testID?: string;
}>;

export const AppUpdateStatusItemBanner = React.memo(function AppUpdateStatusItemBanner(
    props: AppUpdateStatusItemBannerProps,
) {
    const { theme } = useUnistyles();
    const { model, runPrimaryAction, dismiss } = useAppUpdateStatus();

    if (!model.visible) {
        return null;
    }

    const toneColor = resolveToneColor(theme, model.tone);

    return (
        <ItemGroup>
            <Item
                testID={props.testID ?? 'app-update-status-item-banner'}
                title={model.label}
                subtitle={model.message}
                subtitleLines={0}
                titleStyle={{ color: toneColor }}
                subtitleStyle={{ color: toneColor }}
                icon={<Ionicons name={model.iconName} size={28} color={toneColor} />}
                onPress={model.actionDisabled ? undefined : () => {
                    void runPrimaryAction();
                }}
                mode={model.actionDisabled ? 'info' : undefined}
                showChevron={false}
                rightElement={model.dismissLabel ? (
                    <Pressable
                        onPress={(event: GestureResponderEvent) => {
                            event.stopPropagation();
                            dismiss();
                        }}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={model.dismissLabel}
                    >
                        <Ionicons name="close" size={20} color={toneColor} />
                    </Pressable>
                ) : undefined}
            />
        </ItemGroup>
    );
});
