import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usePathname, useRouter } from 'expo-router';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';

const LINKED_FILE_PREFIX = '@';

export type LinkedWorkspaceFilesRowProps = Readonly<{
    sessionId: string;
    paths: readonly string[];
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        maxWidth: '100%',
    },
    chipPressed: {
        opacity: 0.8,
    },
    chipText: {
        color: theme.colors.text,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chipSubtle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
}));

function getBasename(path: string): string {
    const parts = path.split('/');
    const last = parts.at(-1) ?? path;
    return last || path;
}

export const LinkedWorkspaceFilesRow = React.memo((props: LinkedWorkspaceFilesRowProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const { width: windowWidth } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;

    const scopeId = React.useMemo(() => `session:${props.sessionId}`, [props.sessionId]);
    const pane = useAppPaneScope(scopeId);

    const openFile = React.useCallback((path: string) => {
        const layoutIfOpened = resolvePaneLayout({
            containerWidthPx: windowWidth,
            deviceType,
            multiPaneEnabled,
            rightOpen: false,
            detailsOpen: true,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        });

        if (layoutIfOpened.kind === 'single') {
            const href = `/session/${props.sessionId}/file?path=${encodeURIComponent(path)}`;
            prepareMobileSurfaceTransition({
                currentPathname: pathname,
                targetHref: href,
                operation: 'push',
            });
            router.push(href as never);
            return;
        }

        pane.openDetailsTab({
            key: `file:${path}`,
            kind: 'file',
            title: getBasename(path),
            resource: { kind: 'file', path },
        });
    }, [deviceType, multiPaneEnabled, pane, pathname, props.sessionId, router, windowWidth]);

    if (props.paths.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.paths.map((path) => (
                <Pressable
                    key={path}
                    testID={`linked-workspace-file:${path}`}
                    onPress={() => openFile(path)}
                    style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
                    accessibilityRole="button"
                >
                    <Ionicons name="document-text-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.chipSubtle}>{LINKED_FILE_PREFIX}</Text>
                    <Text style={styles.chipText} numberOfLines={1}>
                        {getBasename(path)}
                    </Text>
                </Pressable>
            ))}
        </View>
    );
});
