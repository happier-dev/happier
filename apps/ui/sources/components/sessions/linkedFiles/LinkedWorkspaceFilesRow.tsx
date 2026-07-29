import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';

const LINKED_FILE_PREFIX = '@';

export type LinkedWorkspaceFilesRowProps = Readonly<{
    sessionId: string;
    paths: readonly string[];
    fileOpenEnabled: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        maxWidth: '100%',
        minWidth: 0,
        gap: 8,
        marginTop: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        maxWidth: '100%',
    },
    chipPressed: {
        opacity: 0.8,
    },
    chipText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    chipSubtle: {
        color: theme.colors.text.secondary,
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
    const { width: windowWidth } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const paneScopeLayout = useOptionalAppPaneScopeLayout();

    const scopeId = React.useMemo(() => `session:${props.sessionId}`, [props.sessionId]);
    const pane = useAppPaneScope(scopeId);

    const openFile = React.useCallback((path: string) => {
        const containerWidthPx = paneScopeLayout?.containerWidthPx ?? windowWidth;
        const shouldOpenInDetailsPane = shouldRedirectDetailsRouteToPanes({
            containerWidthPx,
            deviceType,
            multiPaneEnabled,
        });

        if (!shouldOpenInDetailsPane) {
            const href = `/session/${props.sessionId}/file?path=${encodeURIComponent(path)}`;
            router.push(href as any);
            return;
        }

        pane.openDetailsTab({
            key: `file:${path}`,
            kind: 'file',
            title: getBasename(path),
            resource: { kind: 'file', path },
        });
    }, [deviceType, multiPaneEnabled, pane, paneScopeLayout?.containerWidthPx, props.sessionId, router, windowWidth]);

    if (props.paths.length === 0) return null;

    return (
        <View style={styles.row}>
            {props.paths.map((path) => {
                const content = (
                    <>
                    <Ionicons name="document-text-outline" size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.chipSubtle}>{LINKED_FILE_PREFIX}</Text>
                    <Text style={styles.chipText} numberOfLines={1}>
                        {getBasename(path)}
                    </Text>
                    </>
                );
                return props.fileOpenEnabled ? (
                    <Pressable
                        key={path}
                        testID={`linked-workspace-file:${path}`}
                        onPress={() => openFile(path)}
                        style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
                        accessibilityRole="button"
                    >
                        {content}
                    </Pressable>
                ) : (
                    <View
                        key={path}
                        testID={`linked-workspace-file:${path}`}
                        style={styles.chip}
                        accessibilityRole="text"
                    >
                        {content}
                    </View>
                );
            })}
        </View>
    );
});
