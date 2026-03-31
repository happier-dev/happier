import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ResizableDockedPane } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { useIsTablet } from '@/utils/platform/responsive';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';

import { SettingsSidebarV1 } from './SettingsSidebarV1';
import {
    SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX,
    SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX,
    SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX,
} from './settingsSidebarSizing';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface,
    },
    row: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
}));

export const SettingsShellV1 = React.memo(function SettingsShellV1(props: Readonly<{ children: React.ReactNode }>) {
    const styles = stylesheet;
    const { width: windowWidth } = useWindowDimensions();
    const isTablet = useIsTablet();
    const { theme } = useUnistyles();

    const enabled = isTablet;
    const sidebarWidthPx = useLocalSetting('settingsNavSidebarWidthPx') ?? SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX;
    const sidebarWidthBasisPx = useLocalSetting('settingsNavSidebarWidthBasisPx') ?? windowWidth;
    const [, setSidebarWidthPx] = useLocalSettingMutable('settingsNavSidebarWidthPx');
    const [, setSidebarWidthBasisPx] = useLocalSettingMutable('settingsNavSidebarWidthBasisPx');

    const effectiveSidebarWidthPx = React.useMemo(() => {
        return resolveScaledPaneWidthPx({
            preferredWidthPx: typeof sidebarWidthPx === 'number' ? sidebarWidthPx : SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX,
            basisContainerWidthPx: typeof sidebarWidthBasisPx === 'number' ? sidebarWidthBasisPx : windowWidth,
            containerWidthPx: windowWidth,
            minPx: SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX,
            maxPx: SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX,
        });
    }, [sidebarWidthBasisPx, sidebarWidthPx, windowWidth]);

    if (!enabled) {
        return <View style={styles.root}>{props.children}</View>;
    }

    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <ResizableDockedPane
                    testID="settings-shell-v1.sidebarPane"
                    widthPx={effectiveSidebarWidthPx}
                    minWidthPx={SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX}
                    maxWidthPx={SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX}
                    resizeEdge="right"
                    onCommitWidthPx={(nextWidthPx) => {
                        setSidebarWidthPx(nextWidthPx);
                        setSidebarWidthBasisPx(windowWidth);
                    }}
                >
                    <View style={{ flex: 1, minHeight: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.divider }}>
                        <SettingsSidebarV1 />
                    </View>
                </ResizableDockedPane>

                <View style={styles.content}>
                    {props.children}
                </View>
            </View>
        </View>
    );
});
