import * as React from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { CodeView } from '@/components/ui/media/CodeView';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useIsDataReady, useLocalSetting, useSession } from '@/sync/domains/state/storage';
import { sessionReadLogTail } from '@/sync/ops';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

const LOG_TAIL_MAX_BYTES = 200_000;

export default function SessionLogScreen() {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const isDataReady = useIsDataReady();
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    const devModeEnabled = __DEV__ || localDevModeEnabled === true;

    const metadataLogPath = React.useMemo(() => {
        const raw = session?.metadata && typeof (session.metadata as any).sessionLogPath === 'string'
            ? (session.metadata as any).sessionLogPath.trim()
            : '';
        return raw.length > 0 ? raw : null;
    }, [session?.metadata]);

    const [tailText, setTailText] = React.useState('');
    const [resolvedLogPath, setResolvedLogPath] = React.useState<string | null>(null);
    const [truncated, setTruncated] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const copyText = React.useCallback(async (label: string, value: string) => {
        try {
            await Clipboard.setStringAsync(value);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label }));
        } catch {
            Modal.alert(t('common.error'), t('common.error'));
        }
    }, []);

    const refreshTail = React.useCallback(async () => {
        if (!session?.id) return;
        setLoading(true);
        setError(null);
        try {
            const response = await sessionReadLogTail(session.id, { maxBytes: LOG_TAIL_MAX_BYTES });
            if (!response.success) {
                setError(response.error || 'Failed to read session log');
                setTailText('');
                setTruncated(false);
                return;
            }
            setResolvedLogPath(response.path || metadataLogPath || null);
            setTailText(response.tail || '');
            setTruncated(response.truncated === true);
        } finally {
            setLoading(false);
        }
    }, [metadataLogPath, session?.id]);

    React.useEffect(() => {
        if (!devModeEnabled) return;
        if (!session?.id) return;
        if (!metadataLogPath) return;
        void refreshTail();
    }, [devModeEnabled, metadataLogPath, refreshTail, session?.id]);

    if (!isDataReady) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>
                    {t('errors.sessionDeleted')}
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>
                    {t('errors.sessionDeletedDescription')}
                </Text>
            </View>
        );
    }

    if (!devModeEnabled) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
                <Ionicons name="lock-closed-outline" size={42} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.text, fontSize: 18, marginTop: 12, textAlign: 'center', ...Typography.default('semiBold') }}>
                    Developer mode is required
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 8, textAlign: 'center', ...Typography.default() }}>
                    Enable developer mode in settings to view session logs.
                </Text>
            </View>
        );
    }

    return (
        <ItemList>
            <ItemGroup title="Session Log">
                <Item
                    title="Log path"
                    subtitle={resolvedLogPath || metadataLogPath || 'Unavailable'}
                    icon={<Ionicons name="document-text-outline" size={29} color="#5856D6" />}
                    showChevron={false}
                    onPress={() => {
                        const path = resolvedLogPath || metadataLogPath;
                        if (!path) return;
                        void copyText('Session log path', path);
                    }}
                />
                <Item
                    title="Refresh log tail"
                    subtitle={loading ? 'Loading…' : `Read last ${LOG_TAIL_MAX_BYTES.toLocaleString()} bytes`}
                    icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                    onPress={() => void refreshTail()}
                    showChevron={false}
                />
                <Item
                    title="Copy visible log"
                    subtitle={tailText.length > 0 ? 'Copy current tail to clipboard' : 'No log content loaded'}
                    icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                    onPress={() => void copyText('Session log', tailText)}
                    showChevron={false}
                    disabled={tailText.length === 0}
                />
            </ItemGroup>

            {error ? (
                <ItemGroup title="Log status">
                    <Item
                        title="Read error"
                        subtitle={error}
                        icon={<Ionicons name="alert-circle-outline" size={29} color="#FF3B30" />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={truncated ? 'Log tail (truncated)' : 'Log tail'}>
                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                    <CodeView
                        code={tailText.length > 0 ? tailText : '(No log output yet)'}
                        language="text"
                    />
                </View>
            </ItemGroup>
        </ItemList>
    );
}
