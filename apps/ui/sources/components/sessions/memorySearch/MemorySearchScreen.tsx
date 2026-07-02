import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useAllMachines } from '@/sync/domains/state/storage';
import { useAllSessions } from '@/sync/store/hooks';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { getDaemonMemoryStatusStateTranslationKey } from '@/sync/domains/memory/getDaemonMemoryStatusStateTranslationKey';
import { isDaemonMemorySearchUsable } from '@/sync/domains/memory/isDaemonMemorySearchUsable';
import { presentDaemonMemoryStatus } from '@/sync/domains/memory/presentDaemonMemoryStatus';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

import { type MemorySearchHitV1, type MemoryStatusV1 } from '@happier-dev/protocol';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { groupMemorySearchHitsBySession } from './groupMemorySearchHitsBySession';


export const MemorySearchScreen = React.memo(function MemorySearchScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const machines = useAllMachines();
    const allSessions = useAllSessions();
    const activeServerSnapshot = getActiveServerSnapshot();
    const serverId = activeServerSnapshot.serverId;

    const [machineId, setMachineId] = React.useState<string>(() => machines[0]?.id ?? '');
    const [query, setQuery] = React.useState('');
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
    const [hits, setHits] = React.useState<ReadonlyArray<MemorySearchHitV1>>([]);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);
    const [memoryStatus, setMemoryStatus] = React.useState<MemoryStatusV1 | null>(null);
    const [memoryStatusLoading, setMemoryStatusLoading] = React.useState(false);
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);

    React.useEffect(() => {
        if (!machines.find((m) => m.id === machineId)) {
            setMachineId(machines[0]?.id ?? '');
        }
    }, [machines, machineId]);

    const machineTitle = React.useMemo(() => {
        const m = machines.find((x) => x.id === machineId);
        const raw = m?.metadata?.displayName || m?.metadata?.host || machineId;
        return raw && String(raw).trim().length > 0 ? String(raw) : machineId;
    }, [machineId, machines]);
    const machineItems = React.useMemo(() => {
        return machines.map((machine) => ({
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: machine.metadata?.host || undefined,
        }));
    }, [machines]);

    const sessionLabelById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const session of allSessions) {
            if (!session || typeof session.id !== 'string') continue;
            map.set(session.id, getSessionName(session));
        }
        return map;
    }, [allSessions]);

    React.useEffect(() => {
        if (!memorySearchEnabled || !serverId || !machineId) {
            setMemoryStatus(null);
            setMemoryStatusLoading(false);
            return;
        }
        let cancelled = false;
        setMemoryStatus(null);
        setMemoryStatusLoading(true);
        void fetchDaemonMemoryStatus({ serverId, machineId })
            .then((next) => {
                if (!cancelled) setMemoryStatus(next);
            })
            .catch(() => {
                if (!cancelled) setMemoryStatus(null);
            })
            .finally(() => {
                if (!cancelled) setMemoryStatusLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [machineId, memorySearchEnabled, serverId]);

    const statusPresentation = React.useMemo(() => presentDaemonMemoryStatus(memoryStatus), [memoryStatus]);
    const memorySearchUsable = React.useMemo(() => isDaemonMemorySearchUsable(memoryStatus), [memoryStatus]);
    const showEnableCta =
        memoryStatusLoading !== true
        && ((status === 'error' && errorCode === 'memory_disabled') || (memoryStatus?.enabled === false));
    const statusText = React.useMemo(() => {
        if (memoryStatusLoading && !statusPresentation) return t('common.loading');
        return t(getDaemonMemoryStatusStateTranslationKey(statusPresentation));
    }, [memoryStatusLoading, statusPresentation]);
    const groupedHits = React.useMemo(() => groupMemorySearchHitsBySession({
        hits,
        sessionLabelById,
    }), [hits, sessionLabelById]);

    const runSearch = React.useCallback(async () => {
        if (!memorySearchEnabled) return;
        const q = query.trim();
        if (!q || !serverId || !machineId || !memorySearchUsable) return;
        setStatus('loading');
        setErrorCode(null);
        try {
            const parsed = await searchDaemonMemory({
                machineId,
                serverId,
                query: q,
                scope: { type: 'global' },
                mode: 'auto',
                maxResults: 20,
            });
            if (parsed.ok) {
                setHits(parsed.hits);
                setStatus('ready');
                return;
            }
            setErrorCode(typeof parsed.errorCode === 'string' ? parsed.errorCode : null);
            setHits([]);
            setStatus('error');
        } catch {
            setErrorCode(null);
            setHits([]);
            setStatus('error');
        }
    }, [machineId, memorySearchEnabled, memorySearchUsable, query, serverId]);

    if (!memorySearchEnabled) {
        return (
            <View style={{ flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: theme.colors.text.secondary }}>
                    {t('memorySearchSettings.disabled.title')}
                </Text>
                <Pressable
                    testID="memory-search-open-features"
                    onPress={() => router.push('/settings/features' as any)}
                    style={{ paddingVertical: 10 }}
                >
                    <Text style={{ color: theme.colors.text.primary }}>
                        {t('memorySearchSettings.disabled.openFeatureSettings')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, padding: 16 }}>
            <Text style={{ color: theme.colors.text.secondary, paddingVertical: 8 }}>
                {t('memorySearchSettings.screen.machineLabel', { machine: machineTitle })}
            </Text>
            <DropdownMenu
                open={machineMenuOpen}
                onOpenChange={setMachineMenuOpen}
                selectedId={machineId}
                items={machineItems}
                search={true}
                onSelect={(nextId) => {
                    setMachineId(nextId);
                    setHits([]);
                    setStatus('idle');
                    setErrorCode(null);
                    setMachineMenuOpen(false);
                }}
                itemTrigger={{
                    title: t('memorySearchSettings.machine.changeTitle'),
                    itemProps: {
                        testID: 'memory-search-machine-trigger',
                    },
                }}
            />
            <Text style={{ color: theme.colors.text.secondary, marginBottom: 12 }}>
                {statusText}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                    testID="memory-search-query"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('memorySearchSettings.screen.searchPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={{
                        flex: 1,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.input.background,
                        color: theme.colors.text.primary,
                    }}
                />
                <Pressable
                    testID="memory-search-submit"
                    disabled={!memorySearchUsable}
                    accessibilityState={{ disabled: !memorySearchUsable }}
                    onPress={() => { void runSearch(); }}
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: memorySearchUsable ? theme.colors.accent.blue : theme.colors.input.background,
                    }}
                >
                    <View>
                        {/* Using View as a test-friendly placeholder; native button content is styled elsewhere. */}
                    </View>
                </Pressable>
            </View>

            {status === 'loading' ? (
                <Text style={{ color: theme.colors.text.secondary, marginTop: 16 }}>
                    {t('common.loading')}
                </Text>
            ) : null}

            {status === 'ready' && groupedHits.length === 0 ? (
                <Text style={{ color: theme.colors.text.secondary, marginTop: 16 }}>
                    {t('memorySearchSettings.screen.emptyResults')}
                </Text>
            ) : null}

            {status === 'ready' && groupedHits.length > 0 ? (
                <View style={{ marginTop: 16, gap: 10 }}>
                    {groupedHits.map((group) => (
                        <View key={group.sessionId} style={{ gap: 8 }}>
                            <Text style={{ color: theme.colors.text.secondary }}>
                                {group.sessionLabel}
                            </Text>
                            {group.hits.map((hit, idx) => (
                                <Pressable
                                    key={`${hit.sessionId}:${hit.seqFrom}:${hit.seqTo}:${idx}`}
                                    onPress={() => {
                                        const jumpSeq = typeof hit.seqFrom === 'number' ? Math.max(0, Math.trunc(hit.seqFrom)) : 0;
                                        router.push(`/session/${encodeURIComponent(String(hit.sessionId))}?jumpSeq=${encodeURIComponent(String(jumpSeq))}` as any);
                                    }}
                                    style={{
                                        padding: 12,
                                        borderRadius: 12,
                                        backgroundColor: theme.colors.input.background,
                                    }}
                                >
                                    <Text style={{ color: theme.colors.text.primary, marginBottom: 6 }}>
                                        {String(hit.summary ?? '')}
                                    </Text>
                                    <Text style={{ color: theme.colors.text.secondary }}>
                                        {String(hit.sessionId ?? '') + ' · ' + String(hit.seqFrom ?? '')}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    ))}
                </View>
            ) : null}

            {showEnableCta ? (
                <View style={{ marginTop: 16 }}>
                    <Pressable
                        testID="memory-search-enable"
                        onPress={() => {
                            router.push('/settings/memory' as any);
                        }}
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderRadius: 10,
                            backgroundColor: theme.colors.state.success.foreground,
                            alignSelf: 'flex-start',
                        }}
                    >
                        <Text style={{ color: theme.colors.text.primary }}>
                            {t('memorySearchSettings.screen.enableLocalSearch')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});
