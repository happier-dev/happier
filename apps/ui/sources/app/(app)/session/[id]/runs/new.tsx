import * as React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { t } from '@/text';
import { buildExecutionRunsGuidanceBlock, coerceExecutionRunsGuidanceEntries } from '@/sync/domains/settings/executionRunsGuidance';
import { buildAvailableReviewEngineOptions } from '@/sync/domains/reviews/reviewEngineCatalog';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';

type ExecutionRunIntent = 'review' | 'plan' | 'delegate' | 'voice_agent';

function normalizeSessionId(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
    return null;
}

function normalizeIntent(value: unknown): ExecutionRunIntent {
    const raw = typeof value === 'string' ? value.trim() : Array.isArray(value) ? String(value[0] ?? '').trim() : '';
    if (raw === 'review' || raw === 'plan' || raw === 'delegate' || raw === 'voice_agent') return raw;
    return 'review';
}

function defaultPermissionModeForIntent(intent: ExecutionRunIntent): string {
    if (intent === 'review') return 'read_only';
    if (intent === 'plan') return 'read_only';
    return 'default';
}

export default function SessionNewRunScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams();

    const sessionId = normalizeSessionId((params as any)?.id);
    const initialIntent = normalizeIntent((params as any)?.intent);
    const [intent, setIntent] = React.useState<ExecutionRunIntent>(initialIntent);
    const [permissionMode, setPermissionMode] = React.useState<string>(() => defaultPermissionModeForIntent(initialIntent));
    const session = useSession(sessionId ?? '');
    const settings = useSettings();
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId ?? '');

    const initialBackend = React.useMemo(() => {
        const sessionAgent = (session as any)?.metadata?.agent;
        if (typeof sessionAgent === 'string' && enabledAgentIds.includes(sessionAgent as any)) {
            return sessionAgent;
        }
        return enabledAgentIds[0] ?? null;
    }, [enabledAgentIds, session]);

    const backendChoices = React.useMemo(() => {
        if (intent !== 'review') return [...enabledAgentIds];
        return buildAvailableReviewEngineOptions({
            enabledAgentIds,
            executionRunsBackends,
            resolveAgentLabel: (id) => id, // labels are not used on this screen
        }).map((o) => o.id);
    }, [enabledAgentIds, executionRunsBackends, intent]);

    const [selectedBackends, setSelectedBackends] = React.useState<string[]>(() => (initialBackend ? [initialBackend] : []));
    const [instructions, setInstructions] = React.useState('');
    const [isStarting, setIsStarting] = React.useState(false);
    const canStart = Boolean(sessionId && selectedBackends.length > 0 && instructions.trim().length > 0 && !isStarting);

    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: 'Start run',
        headerBackTitle: t('common.back'),
    }), []);

    if (!sessionId) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 16 }}>
                <Text style={{ color: theme.colors.text }}>{t('errors.sessionDeleted')}</Text>
            </View>
        );
    }

    const toggleBackend = (backendId: string) => {
        setSelectedBackends((prev) => {
            const has = prev.includes(backendId);
            if (has) return prev.filter((id) => id !== backendId);
            return [...prev, backendId];
        });
    };

    const onStart = async () => {
        if (!canStart) return;
        const trimmed = instructions.trim();
        setIsStarting(true);
        try {
            const actionId = intent === 'review' ? 'review.start' : intent === 'plan' ? 'plan.start' : 'delegate.start';
            const res = await actionExecutor.execute(
                actionId as any,
                intent === 'review'
                    ? {
                        sessionId,
                        engineIds: selectedBackends,
                        instructions: trimmed,
                        permissionMode,
                        changeType: 'committed',
                        base: { kind: 'none' },
                    }
                    : {
                        sessionId,
                        backendIds: selectedBackends,
                        instructions: trimmed,
                        permissionMode,
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                    },
                { defaultSessionId: sessionId },
            );

            if (!res.ok) return;
            const payload: any = res.result;
            const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
            if (results.some((r) => r && r.ok === false)) return;
            router.push(`/session/${sessionId}/runs` as any);
        } finally {
            setIsStarting(false);
        }
    };

    const guidancePreview = React.useMemo(() => {
        if ((settings as any).executionRunsGuidanceEnabled !== true) return '';
        const maxCharsRaw = (settings as any).executionRunsGuidanceMaxChars;
        const maxChars = typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) ? Math.floor(maxCharsRaw) : 4_000;
        const entries = coerceExecutionRunsGuidanceEntries((settings as any).executionRunsGuidanceEntries);
        return buildExecutionRunsGuidanceBlock({ entries, maxChars: Math.min(maxChars, 2_000) }).text;
    }, [settings]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
            <Stack.Screen options={screenOptions} />
            <ConstrainedScreenContent
                style={{
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 16,
                }}
            >
                <View style={{ gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>Intent</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {(['review', 'plan', 'delegate'] as const).map((next) => {
                            const selected = intent === next;
                            return (
                                <Pressable
                                    key={next}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Select intent ${next}`}
                                    onPress={() => {
                                        setIntent(next);
                                        setPermissionMode(defaultPermissionModeForIntent(next));
                                        if (next !== 'review') {
                                            setSelectedBackends((prev) => prev.filter((id) => id !== 'coderabbit'));
                                        }
                                    }}
                                    style={({ pressed }) => ({
                                        paddingVertical: 8,
                                        paddingHorizontal: 10,
                                        borderRadius: 8,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: selected ? theme.colors.text : theme.colors.textSecondary }}>
                                        {next}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>

                <View style={{ gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>Permissions</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {(['read_only', 'default'] as const).map((next) => {
                            const selected = permissionMode === next;
                            return (
                                <Pressable
                                    key={next}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Select permissionMode ${next}`}
                                    onPress={() => setPermissionMode(next)}
                                    style={({ pressed }) => ({
                                        paddingVertical: 8,
                                        paddingHorizontal: 10,
                                        borderRadius: 8,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: selected ? theme.colors.text : theme.colors.textSecondary }}>
                                        {next}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>

                <View style={{ gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>Backends</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {backendChoices.map((backendId) => {
                            const selected = selectedBackends.includes(backendId);
                            return (
                                <Pressable
                                    key={backendId}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Toggle backend ${backendId}`}
                                    onPress={() => toggleBackend(backendId)}
                                    style={({ pressed }) => ({
                                        paddingVertical: 8,
                                        paddingHorizontal: 10,
                                        borderRadius: 8,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: selected ? theme.colors.text : theme.colors.textSecondary }}>
                                        {backendId}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>

                <View style={{ gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>Instructions</Text>
                    <TextInput
                        value={instructions}
                        onChangeText={setInstructions}
                        placeholder={'What should the sub-agent do?'}
                        placeholderTextColor={theme.colors.textSecondary}
                        multiline
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            borderRadius: 10,
                            padding: 12,
                            minHeight: 96,
                            color: theme.colors.text,
                        }}
                    />
                </View>

                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Start run"
                        onPress={onStart}
                        disabled={!canStart}
                        style={({ pressed }) => ({
                            paddingVertical: 10,
                            paddingHorizontal: 14,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surfaceHigh,
                            opacity: !canStart ? 0.5 : pressed ? 0.7 : 1,
                        })}
                    >
                        <Text style={{ color: theme.colors.text }}>Start</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                        onPress={() => router.back()}
                        style={({ pressed }) => ({
                            paddingVertical: 10,
                            paddingHorizontal: 14,
                            borderRadius: 10,
                            opacity: pressed ? 0.7 : 1,
                        })}
                    >
                        <Text style={{ color: theme.colors.textSecondary }}>{t('common.cancel') ?? 'Cancel'}</Text>
                    </Pressable>
                </View>

                {guidancePreview ? (
                    <View style={{ gap: 6 }}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Guidance preview</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontFamily: 'Menlo' }}>
                            {guidancePreview}
                        </Text>
                    </View>
                ) : null}
            </ConstrainedScreenContent>
        </View>
    );
}
