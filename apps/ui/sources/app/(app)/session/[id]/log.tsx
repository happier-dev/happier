import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { CodeView } from '@/components/ui/media/CodeView';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { Typography } from '@/constants/Typography';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useSession } from '@/sync/domains/state/storage';
import { machineReadSessionLogTail } from '@/sync/ops';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';


const LOG_TAIL_MAX_BYTES = 200_000;

export default function SessionLogScreen() {
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
    const session = useSession(sessionId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;

    const metadataLogPath = React.useMemo(() => {
        const raw = typeof ownerMetadata?.sessionLogPath === 'string'
            ? ownerMetadata.sessionLogPath.trim()
            : '';
        return raw.length > 0 ? raw : null;
    }, [ownerMetadata]);

    const resolvedMachineId = React.useMemo(() => {
        return session?.id ? readMachineTargetForSession(session.id)?.machineId ?? null : null;
    }, [ownerMetadata, session?.id, session?.updatedAt]);

    const [tailText, setTailText] = React.useState('');
    const [resolvedLogPath, setResolvedLogPath] = React.useState<string | null>(null);
    const [truncated, setTruncated] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const refreshTail = React.useCallback(async () => {
        if (!session?.id) return;
        if (!sessionHydrated) return;
        if (!metadataLogPath) return;
        if (!resolvedMachineId) {
            setError(t('sessionLog.readFailed'));
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const response = await machineReadSessionLogTail(resolvedMachineId, {
                path: metadataLogPath,
                maxBytes: LOG_TAIL_MAX_BYTES,
            });
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
            setLoading(false);
        }
    }, [metadataLogPath, resolvedMachineId, session?.id, sessionHydrated]);

    React.useEffect(() => {
        if (!session?.id) return;
        if (!sessionHydrated) return;
        if (!metadataLogPath) return;
        void refreshTail();
    }, [metadataLogPath, refreshTail, session?.id, sessionHydrated]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    if (!sessionHydrated) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.primary, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>
                    {t('errors.sessionDeleted')}
                </Text>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>
                    {t('errors.sessionDeletedDescription')}
                </Text>
            </View>
        );
    }

    return (
        <ItemList>
            <ItemGroup title={t('sessionLog.title')}>
                <Item
                    title={t('sessionLog.logPathTitle')}
                    subtitle={resolvedLogPath || metadataLogPath || t('sessionLog.unavailable')}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                    copy={resolvedLogPath || metadataLogPath || false}
                    disabled={!resolvedLogPath && !metadataLogPath}
                />
                <Item
                    title={t('sessionLog.refreshTailTitle')}
                    subtitle={loading ? t('common.loading') : t('sessionLog.refreshTailSubtitle', { maxBytes: LOG_TAIL_MAX_BYTES.toLocaleString() })}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => void refreshTail()}
                    showChevron={false}
                />
                <Item
                    title={t('sessionLog.copyVisibleTitle')}
                    subtitle={tailText.length > 0 ? t('sessionLog.copyVisibleSubtitleLoaded') : t('sessionLog.copyVisibleSubtitleEmpty')}
                    icon={<Ionicons name="copy-outline" size={29} color={theme.colors.accent.blue} />}
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
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={truncated ? t('sessionLog.tailTitleTruncated') : t('sessionLog.tailTitle')}>
                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                    <CodeView
                        code={tailText.length > 0 ? tailText : t('sessionLog.noOutputYet')}
                        language="text"
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
}
