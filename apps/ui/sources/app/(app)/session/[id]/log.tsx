import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { CodeView } from '@/components/ui/media/CodeView';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { Typography } from '@/constants/Typography';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useSession } from '@/sync/domains/state/storage';
import { machineReadSessionLogTail } from '@/sync/ops';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { Icon } from '@/components/ui/icons/Icon';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';


const LOG_TAIL_MAX_BYTES = 200_000;

export function SessionLogScreen() {
    useDestinationPageTitle(t('sessionLog.title'));
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const { id } = params;
    const sessionId = normalizeSessionId(id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionLogRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSession(sessionId, routeScope.hydrationOptions?.serverId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;

    const metadataLogPath = React.useMemo(() => {
        const raw = typeof ownerMetadata?.sessionLogPath === 'string'
            ? ownerMetadata.sessionLogPath.trim()
            : '';
        return raw.length > 0 ? raw : null;
    }, [ownerMetadata]);

    const resolvedMachineId = useSessionMachineTarget(sessionId, routeScope.hydrationOptions?.serverId)?.machineId ?? null;

    const [tailText, setTailText] = React.useState('');
    const [resolvedLogPath, setResolvedLogPath] = React.useState<string | null>(null);
    const [truncated, setTruncated] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const activeRequest = React.useRef<AbortController | null>(null);

    const refreshTail = React.useCallback(async () => {
        activeRequest.current?.abort();
        activeRequest.current = null;
        setLoading(false);
        if (!session?.id) return;
        if (!sessionHydrated) return;
        if (!metadataLogPath) return;
        if (!resolvedMachineId) {
            setError(t('sessionLog.readFailed'));
            return;
        }
        setLoading(true);
        setError(null);
        const request = new AbortController();
        activeRequest.current = request;
        try {
            const response = await machineReadSessionLogTail(resolvedMachineId, {
                path: metadataLogPath,
                maxBytes: LOG_TAIL_MAX_BYTES,
            }, { serverId: routeScope.hydrationOptions?.serverId, signal: request.signal });
            if (request.signal.aborted) return;
            if (!response.success) {
                setError(response.error || t('sessionLog.readFailed'));
                setTailText('');
                setTruncated(false);
                setResolvedLogPath(metadataLogPath || null);
                return;
            }
            setResolvedLogPath(response.path || metadataLogPath || null);
            setTailText(response.tail || '');
            setTruncated(response.truncated === true);
        } finally {
            if (activeRequest.current === request) {
                activeRequest.current = null;
                setLoading(false);
            }
        }
    }, [metadataLogPath, resolvedMachineId, routeScope.hydrationOptions?.serverId, session?.id, sessionHydrated]);

    React.useEffect(() => {
        if (!session?.id) return;
        if (!sessionHydrated) return;
        if (!metadataLogPath) return;
        void refreshTail();
        return () => {
            activeRequest.current?.abort();
            activeRequest.current = null;
            setLoading(false);
        };
    }, [metadataLogPath, refreshTail, session?.id, sessionHydrated]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    if (!sessionHydrated) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="hourglass" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('heading'), marginTop: theme.space.s16,  }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="trash" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.primary, ...Typography.variant('title'), marginTop: theme.space.s16,  }}>
                    {t('errors.sessionDeleted')}
                </Text>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: theme.space.s8, textAlign: 'center', paddingHorizontal: theme.space.s32, ...Typography.default() }}>
                    {t('errors.sessionDeletedDescription')}
                </Text>
            </View>
        );
    }

    return (
        <ItemList presentation="grouped">
            <ItemGroup title={t('sessionLog.title')}>
                <Item
                    title={t('sessionLog.logPathTitle')}
                    subtitle={resolvedLogPath || metadataLogPath || t('sessionLog.unavailable')}
                    icon={<Icon name="file-text" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                    copy={resolvedLogPath || metadataLogPath || false}
                    disabled={!resolvedLogPath && !metadataLogPath}
                />
                <Item
                    title={t('sessionLog.refreshTailTitle')}
                    subtitle={loading ? t('common.loading') : t('sessionLog.refreshTailSubtitle', { maxBytes: LOG_TAIL_MAX_BYTES.toLocaleString() })}
                    icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => void refreshTail()}
                    showChevron={false}
                />
                <Item
                    title={t('sessionLog.copyVisibleTitle')}
                    subtitle={tailText.length > 0 ? t('sessionLog.copyVisibleSubtitleLoaded') : t('sessionLog.copyVisibleSubtitleEmpty')}
                    icon={<Icon name="copy" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    disabled={tailText.length === 0}
                    copy={tailText.length > 0 ? tailText : false}
                />
            </ItemGroup>

            {error ? (
                <ItemGroup title={t('sessionLog.statusTitle')}>
                    <Item
                        title={t('sessionLog.readErrorTitle')}
                        subtitle={error}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={truncated ? t('sessionLog.tailTitleTruncated') : t('sessionLog.tailTitle')}>
                <View style={{ marginHorizontal: theme.space.s16, marginBottom: theme.space.s12 }}>
                    <CodeView
                        code={tailText.length > 0 ? tailText : t('sessionLog.noOutputYet')}
                        language="text"
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
}

export { SessionLogScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionLogScreen} />; }
