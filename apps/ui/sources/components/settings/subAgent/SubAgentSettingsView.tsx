import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    buildExecutionRunsGuidanceBlock,
    coerceExecutionRunsGuidanceEntries,
    type ExecutionRunsGuidanceEntry,
} from '@/sync/domains/settings/executionRunsGuidance';
import { t } from '@/text';

import { showSubAgentGuidanceRuleEditorModal } from './guidance/showSubAgentGuidanceRuleEditorModal';

function clampInt(value: number, bounds: Readonly<{ min: number; max: number }>): number {
    if (!Number.isFinite(value)) return bounds.min;
    return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

function truncateForTitle(text: string, maxChars: number): string {
    const normalized = String(text ?? '').trim();
    if (normalized.length <= maxChars) return normalized;
    const head = normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd();
    return `${head}...`;
}

function getRuleTitle(entry: ExecutionRunsGuidanceEntry): string {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (title) return title;
    const desc = String(entry.description ?? '').trim();
    if (!desc) return t('subAgentGuidance.settings.rules.untitled');
    return truncateForTitle(desc.split('\n')[0]?.trim() || t('subAgentGuidance.settings.rules.untitled'), 56);
}

function getRuleSubtitle(entry: ExecutionRunsGuidanceEntry): string {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const desc = String(entry.description ?? '').trim();

    const metaParts: string[] = [];
    if (typeof entry.suggestedBackendId === 'string' && entry.suggestedBackendId.trim().length > 0) {
        const raw = entry.suggestedBackendId.trim();
        let label = raw;
        if (isAgentId(raw as any)) {
            const core = getAgentCore(raw as AgentId);
            const displayName = t(core.displayNameKey).trim();
            label = displayName ? `${displayName} (${raw})` : raw;
        }
        metaParts.push(t('subAgentGuidance.settings.rules.meta.target', { value: label }));
    }
    if (entry.suggestedModelId) metaParts.push(t('subAgentGuidance.settings.rules.meta.model', { value: entry.suggestedModelId }));
    if (entry.suggestedIntent) metaParts.push(t('subAgentGuidance.settings.rules.meta.intent', { value: entry.suggestedIntent }));
    const meta = metaParts.length > 0 ? metaParts.join('  •  ') : '';

    const descBody = desc || (title ? '' : t('subAgentGuidance.settings.rules.descriptionFallback'));
    if (descBody && meta) return `${descBody}\n${meta}`;
    return descBody || meta || t('subAgentGuidance.settings.rules.tapToEdit');
}

export const SubAgentSettingsView = React.memo(function SubAgentSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const [enabled, setEnabled] = useSettingMutable('executionRunsGuidanceEnabled');
    const [maxCharsRaw, setMaxChars] = useSettingMutable('executionRunsGuidanceMaxChars');
    const [entriesRaw, setEntries] = useSettingMutable('executionRunsGuidanceEntries');

    const maxChars = clampInt(Number(maxCharsRaw ?? 4_000), { min: 200, max: 50_000 });
    const entries = React.useMemo(
        () => coerceExecutionRunsGuidanceEntries(entriesRaw),
        [entriesRaw],
    );

    const setEntriesNext = React.useCallback((next: readonly ExecutionRunsGuidanceEntry[]) => {
        setEntries(next as any);
    }, [setEntries]);

    const addRule = React.useCallback(async () => {
        const draft: ExecutionRunsGuidanceEntry = {
            id: `guidance_${randomUUID()}`,
            description: '',
            enabled: true,
        };
        const res = await showSubAgentGuidanceRuleEditorModal({ mode: 'create', entry: draft });
        if (!res) return;
        if (res.kind === 'save') {
            setEntriesNext([...(entries ?? []), res.entry]);
        }
    }, [entries, setEntriesNext]);

    const editRule = React.useCallback(async (entry: ExecutionRunsGuidanceEntry) => {
        const res = await showSubAgentGuidanceRuleEditorModal({ mode: 'edit', entry });
        if (!res) return;
        if (res.kind === 'delete') {
            setEntriesNext((entries ?? []).filter((e) => e.id !== entry.id));
            return;
        }
        if (res.kind === 'save') {
            setEntriesNext((entries ?? []).map((e) => (e.id === entry.id ? res.entry : e)));
        }
    }, [entries, setEntriesNext]);

    const previewText = React.useMemo(() => {
        if (enabled !== true) return '';
        const { text } = buildExecutionRunsGuidanceBlock({ entries, maxChars: Math.min(maxChars, 1600) });
        return text;
    }, [enabled, entries, maxChars]);

    if (!executionRunsEnabled) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('subAgentGuidance.settings.groupTitle')}
                    footer={t('subAgentGuidance.settings.disabled.footer')}
                >
                    <Item
                        title={t('subAgentGuidance.settings.disabled.enableExecutionRuns.title')}
                        subtitle={t('subAgentGuidance.settings.disabled.enableExecutionRuns.subtitle')}
                        icon={<Ionicons name="flask-outline" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => router.push('/(app)/settings/features')}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('subAgentGuidance.settings.groupTitle')}
                footer={t('subAgentGuidance.settings.footer')}
            >
                <Item
                    title={t('subAgentGuidance.settings.enableInjection.title')}
                    subtitle={
                        enabled === true
                            ? t('subAgentGuidance.ruleEditor.enabledState.enabled')
                            : t('subAgentGuidance.ruleEditor.enabledState.disabled')
                    }
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
                    rightElement={<Switch value={enabled === true} onValueChange={(v) => setEnabled(v as any)} />}
                    showChevron={false}
                    onPress={() => setEnabled((enabled !== true) as any)}
                />

                <Item
                    title={t('subAgentGuidance.settings.characterBudget.title')}
                    subtitle={t('subAgentGuidance.settings.characterBudget.subtitle', { value: maxChars.toLocaleString() })}
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={async () => {
                        const raw = await Modal.prompt(
                            t('subAgentGuidance.settings.characterBudget.promptTitle'),
                            t('subAgentGuidance.settings.characterBudget.promptBody'),
                        );
                        if (raw == null) return;
                        const parsed = Number(String(raw).replace(/[^0-9]/g, ''));
                        if (!Number.isFinite(parsed)) return;
                        setMaxChars(clampInt(parsed, { min: 200, max: 50_000 }) as any);
                    }}
                />
            </ItemGroup>

            <ItemGroup
                title={t('subAgentGuidance.settings.rules.groupTitle')}
                footer={
                    enabled === true
                        ? t('subAgentGuidance.settings.rules.footerEnabled')
                        : t('subAgentGuidance.settings.rules.footerDisabled')
                }
            >
                {entries.length === 0 ? (
                    <Item
                        title={t('subAgentGuidance.settings.rules.emptyTitle')}
                        subtitle={t('subAgentGuidance.settings.rules.emptySubtitle')}
                        icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                        onPress={() => {
                            void addRule();
                        }}
                    />
                ) : (
                    entries.map((entry) => (
                        <Item
                            key={entry.id}
                            title={getRuleTitle(entry)}
                            subtitle={getRuleSubtitle(entry)}
                            subtitleLines={2}
                            icon={
                                <Ionicons
                                    name={entry.enabled === false ? 'pause-circle-outline' : 'play-circle-outline'}
                                    size={29}
                                    color={entry.enabled === false ? theme.colors.textSecondary : '#34C759'}
                                />
                            }
                            onPress={() => {
                                void editRule(entry);
                            }}
                        />
                    ))
                )}

                <Item
                    title={t('subAgentGuidance.settings.rules.addRuleTitle')}
                    subtitle={t('subAgentGuidance.settings.rules.addRuleSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => {
                        void addRule();
                    }}
                />
            </ItemGroup>

            {enabled === true && previewText ? (
                <ItemGroup title={t('subAgentGuidance.settings.preview.title')} footer={t('subAgentGuidance.settings.preview.footer')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <View
                            style={{
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                borderRadius: 12,
                                padding: 12,
                                backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                            }}
                        >
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                                {t('subAgentGuidance.settings.preview.systemPromptLabel')}
                            </Text>
                            <Text
                                style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    color: theme.colors.text,
                                    ...Typography.mono(),
                                    lineHeight: 16,
                                }}
                            >
                                {previewText}
                            </Text>
                        </View>
                    </View>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
