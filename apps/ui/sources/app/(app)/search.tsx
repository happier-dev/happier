import * as React from 'react';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { UniversalSearchController } from '@/components/appShell/search/UniversalSearchController';
import { useUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { resolveUniversalSearchRouteInitialScope } from '@/components/appShell/search/universalSearchScope';
import { TERMINAL_JUMP_ROUTE_PARAM } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        alignItems: 'center' as const,
        paddingHorizontal: 16,
        paddingVertical: 16,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
    routeClose: {
        alignSelf: 'stretch',
        alignItems: 'flex-end',
        marginBottom: 8,
    },
}));

export default function UniversalSearchRoute(): React.ReactElement {
    const router = useRouter();
    const params = useGlobalSearchParams<{ q?: string | string[]; source?: string | string[]; sessionId?: string | string[]; accountId?: string | string[]; serverId?: string | string[]; machineId?: string | string[]; rootPath?: string | string[]; [TERMINAL_JUMP_ROUTE_PARAM]?: string | string[] }>();
    const runtime = useUniversalSearchRuntime();
    const initialQuery = typeof params.q === 'string' ? params.q : '';
    const initialSource = params.source === 'fileContent' ? 'fileContent' : undefined;
    const activeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    const initialScope = React.useMemo(() => resolveUniversalSearchRouteInitialScope(params), [params]);
    const terminalScopeId = params[TERMINAL_JUMP_ROUTE_PARAM];
    const terminalJump = React.useMemo(
        () => (typeof terminalScopeId === 'string' && terminalScopeId.length > 0 ? { scopeId: terminalScopeId } : undefined),
        [terminalScopeId],
    );
    const commands = React.useMemo(
        () => runtime.buildCommands(activeSessionId, initialScope ?? undefined),
        [activeSessionId, initialScope, runtime],
    );
    const close = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/' as never);
    }, [router]);
    const controller = (
        <UniversalSearchController
            commands={commands}
            initialQuery={initialQuery}
            initialSource={initialSource}
            activeSessionId={activeSessionId}
            initialScope={initialScope}
            terminalJump={terminalJump}
            presentation="route"
            onRequestClose={close}
        />
    );
    if (Platform.OS !== 'web') return controller;
    return (
        <View testID="universal-search-route-page" style={styles.page}>
            <View style={styles.routeClose}>
                <IconButton
                    testID="universal-search-route-close"
                    iconName="x"
                    accessibilityLabel={t('common.close')}
                    onPress={close}
                    minimumInteractiveTargetSize={44}
                />
            </View>
            <ConstrainedScreenContent style={styles.content}>
                {controller}
            </ConstrainedScreenContent>
        </View>
    );
}
