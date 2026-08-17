import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import {
    resolveSettingsRouteParentPathname,
    shouldShowSettingsParentBackButton,
} from '@/components/settings/navigation/settingsRouteRegistry';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Floating controls for the settings modal (tablet/desktop), positioned absolutely over the
 * content in place of the removed navigator header.
 *
 * Currently just a back affordance shown on deeper sub-screens — top-level categories are
 * reached from the nav rail, and the modal itself is dismissed via its backdrop/gesture, so
 * there is no close icon.
 */
export const SettingsModalFloatingControls = React.memo(function SettingsModalFloatingControls() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const parentPathname = resolveSettingsRouteParentPathname(pathname);
    const handleBack = React.useCallback(() => {
        if (!parentPathname) return;
        const result = runGuardedNavigation(() => router.navigate(parentPathname as never));
        if (result !== true) {
            fireAndForget(result, { tag: 'SettingsModalFloatingControls.back' });
        }
    }, [parentPathname, router]);

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel: true }) || !parentPathname) {
        return null;
    }

    return (
        <View pointerEvents="box-none" style={styles.overlay}>
            <Pressable
                testID="settings-modal-back"
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
                hitSlop={8}
                onPress={handleBack}
                style={styles.backButton}
            >
                <Icon
                    name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    overlay: {
        position: 'absolute',
        top: 4,
        left: 4,
        zIndex: 10,
    },
    backButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
}));
