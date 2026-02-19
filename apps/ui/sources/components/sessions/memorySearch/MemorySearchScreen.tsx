import * as React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useAllMachines } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { MemorySearchResultV1Schema, RPC_METHODS } from '@happier-dev/protocol';

export const MemorySearchScreen = React.memo(function MemorySearchScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const machines = useAllMachines();
    const activeServerSnapshot = getActiveServerSnapshot();
    const serverId = activeServerSnapshot.serverId;

    const [machineId, setMachineId] = React.useState<string>(() => machines[0]?.id ?? '');
    const [query, setQuery] = React.useState('');
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
    const [hits, setHits] = React.useState<ReadonlyArray<any>>([]);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);

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

    const runSearch = React.useCallback(async () => {
        if (!memorySearchEnabled) return;
        const q = query.trim();
        if (!q || !serverId || !machineId) return;
        setStatus('loading');
        setErrorCode(null);
        try {
            const raw = await machineRpcWithServerScope<unknown, unknown>({
                machineId,
                serverId,
                method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
                payload: {
                    v: 1,
                    query: q,
                    scope: { type: 'global' },
                    mode: 'auto',
                    maxResults: 20,
                },
            });
            const parsed = MemorySearchResultV1Schema.parse(raw);
            if (parsed.ok) {
                setHits(parsed.hits);
                setStatus('ready');
                return;
            }
            setErrorCode((parsed as any)?.errorCode ? String((parsed as any).errorCode) : null);
            setHits([]);
            setStatus('error');
        } catch {
            setErrorCode(null);
            setHits([]);
            setStatus('error');
        }
    }, [machineId, memorySearchEnabled, query, serverId]);

    if (!memorySearchEnabled) {
        return (
            <View style={{ flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: theme.colors.textSecondary }}>
                    Memory search is disabled.
                </Text>
                <Pressable
                    testID="memory-search-open-features"
                    onPress={() => router.push('/settings/features' as any)}
                    style={{ paddingVertical: 10 }}
                >
                    <Text style={{ color: theme.colors.text }}>
                        Open feature settings
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, padding: 16 }}>
            <Pressable
                testID="memory-search-machine"
                onPress={() => {
                    if (machines.length <= 1) return;
                    const idx = machines.findIndex((m) => m.id === machineId);
                    const nextIdx = idx >= 0 ? (idx + 1) % machines.length : 0;
                    const nextId = machines[nextIdx]?.id ?? '';
                    setMachineId(nextId);
                    setHits([]);
                    setStatus('idle');
                    setErrorCode(null);
                }}
                style={{ paddingVertical: 8 }}
            >
                <Text style={{ color: theme.colors.textSecondary }}>
                    {'Machine: ' + machineTitle}
                </Text>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search memory"
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={{
                        flex: 1,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.input.background,
                        color: theme.colors.text,
                    }}
                />
                <Pressable
                    testID="memory-search-submit"
                    onPress={() => { void runSearch(); }}
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: '#007AFF',
                    }}
                >
                    <View>
                        {/* Using View as a test-friendly placeholder; native button content is styled elsewhere. */}
                    </View>
                </Pressable>
            </View>

            {status === 'ready' ? (
                <View style={{ marginTop: 16, gap: 10 }}>
                    {hits.map((hit: any, idx: number) => (
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
                            <Text style={{ color: theme.colors.text, marginBottom: 6 }}>
                                {String(hit.summary ?? '')}
                            </Text>
                            <Text style={{ color: theme.colors.textSecondary }}>
                                {String(hit.sessionId ?? '') + ' · ' + String(hit.seqFrom ?? '')}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            {status === 'error' && errorCode === 'memory_disabled' ? (
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
                            backgroundColor: '#34C759',
                            alignSelf: 'flex-start',
                        }}
                    >
                        <Text style={{ color: '#fff' }}>
                            Enable Local Memory Search
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});
