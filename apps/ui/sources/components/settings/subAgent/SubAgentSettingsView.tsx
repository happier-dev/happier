import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { type BackendTargetRefV2 } from '@happier-dev/protocol';

import { createPluginAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
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
import { useSetting } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import {
    buildExecutionRunsGuidanceBlock,
    coerceExecutionRunsGuidanceEntries,
    type ExecutionRunsGuidanceEntry,
} from '@/sync/domains/settings/executionRunsGuidance';
import { t } from '@/text';

import { showSubAgentGuidanceRuleEditorModal } from './guidance/showSubAgentGuidanceRuleEditorModal';
import { Icon } from '@/components/ui/icons/Icon';

function resolveText(input: string | Readonly<{ fallback: string }> | undefined): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input === 'string') return input;
    return input.fallback;
}

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

function getBackendTargetLabel(target: BackendTargetRefV2, backendEntries: readonly ResolvedBackendCatalogEntry[]): string {
    const resolved = backendEntries.find((entry) => entry.backendTargetKey === resolveBackendTargetKeyV2(target)) ?? null;
    if (resolved) return resolved.title;

    if (!target.configuredBackendId) {
        const core = getAgentCore(target.backendId as AgentId);
        const displayName = core ? t(core.displayNameKey).trim() : '';
        return displayName ? `${displayName} (${target.backendId})` : target.backendId;
    }

    return resolveBackendTargetKeyV2(target);
}

function getRuleSubtitle(entry: ExecutionRunsGuidanceEntry, backendEntries: readonly ResolvedBackendCatalogEntry[]): string {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const desc = String(entry.description ?? '').trim();

    const metaParts: string[] = [];
    if (entry.suggestedBackendTarget) {
        const label = getBackendTargetLabel(entry.suggestedBackendTarget, backendEntries);
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
    const enabledAgentIds = useEnabledAgentIds();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const [enabled, setEnabled] = useSettingMutable('executionRunsGuidanceEnabled');
    const [maxCharsRaw, setMaxChars] = useSettingMutable('executionRunsGuidanceMaxChars');
    const [entriesRaw, setEntries] = useSettingMutable('executionRunsGuidanceEntries');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const machines = useAllMachines();
    const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;
    const preferredMachineId = React.useMemo(() => {
        return resolvePreferredMachineId({
            machines,
            recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
        });
    }, [machines, recentMachinePaths]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: preferredMachineId,
        enabled: Boolean(preferredMachineId),
        staleMs: 60_000,
    });

    const maxChars = clampInt(Number(maxCharsRaw ?? 4_000), { min: 200, max: 50_000 });
    const entries = React.useMemo(
        () => coerceExecutionRunsGuidanceEntries(entriesRaw),
        [entriesRaw],
    );
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: acpCatalogSettingsV1 as any,
            backendEnabledByTargetKey: backendEnabledByTargetKey as Record<string, boolean> | undefined,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        });
    }, [
        acpCatalogSettingsV1,
        backendEnabledByTargetKey,
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
    ]);
    const agentSubagentSections = React.useMemo(() => (
        Object.values(daemonMergedProjection.inputs?.pluginProjectionById ?? {}).flatMap((plugin) => (
            plugin.editableSettingsGroups.flatMap((group) => {
                const target = group.target;
                if (target.kind !== 'agent') return [];
                return group.presentation.subagentSections.map((section) => ({
                    agent: target.agent,
                    section,
                }));
            })
        ))
    ), [daemonMergedProjection.inputs?.pluginProjectionById]);

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

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('subAgentGuidance.settings.overview.groupTitle')}
                footer={t('subAgentGuidance.settings.overview.footer')}
            >
                <Item
                    title={t('subAgentGuidance.settings.overview.explainerTitle')}
                    subtitle={t('subAgentGuidance.settings.overview.explainerSubtitle')}
                    icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
                <Item
                    title={t('subAgentGuidance.settings.overview.happierStatusTitle')}
                    subtitle={
                        executionRunsEnabled
                            ? t('subAgentGuidance.settings.overview.happierStatusEnabledSubtitle')
                            : t('subAgentGuidance.settings.overview.happierStatusDisabledSubtitle')
                    }
                    icon={<Icon name="sparkle" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => router.push(SETTINGS_ROUTES.features)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('subAgentGuidance.settings.related.groupTitle')}
                footer={t('subAgentGuidance.settings.related.footer')}
            >
                <Item
                    title={t('subAgentGuidance.settings.related.sessionTitle')}
                    subtitle={t('subAgentGuidance.settings.related.sessionSubtitle')}
                    icon={<Icon name="arrows-left-right" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push(SETTINGS_ROUTES.session)}
                />
                <Item
                    title={t('subAgentGuidance.settings.related.providersTitle')}
                    subtitle={t('subAgentGuidance.settings.related.providersSubtitle')}
                    icon={<Icon name="sparkle" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => router.push(SETTINGS_ROUTES.agents)}
                />
                <Item
                    title={t('subAgentGuidance.settings.related.backendsTitle')}
                    subtitle={t('subAgentGuidance.settings.related.backendsSubtitle')}
                    icon={<Icon name="graph" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push(SETTINGS_ROUTES.agents)}
                />
            </ItemGroup>

            {executionRunsEnabled ? (
                <>
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
                            icon={<Icon name="sparkle" size={29} color={theme.colors.accent.orange} />}
                            rightElement={<Switch value={enabled === true} onValueChange={(v) => setEnabled(v as any)} />}
                            showChevron={false}
                            onPress={() => setEnabled((enabled !== true) as any)}
                        />

                        <Item
                            title={t('subAgentGuidance.settings.characterBudget.title')}
                            subtitle={t('subAgentGuidance.settings.characterBudget.subtitle', { value: maxChars.toLocaleString() })}
                            icon={<Icon name="text-aa" size={29} color={theme.colors.text.secondary} />}
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
                                icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                                onPress={() => {
                                    void addRule();
                                }}
                            />
                        ) : (
                            entries.map((entry) => (
                                <Item
                                    key={entry.id}
                                    title={getRuleTitle(entry)}
                                    subtitle={getRuleSubtitle(entry, resolvedBackendEntries)}
                                    subtitleLines={2}
                                    icon={
                                        <Icon
                                            name={entry.enabled === false ? 'pause-circle' : 'play-circle'}
                                            size={29}
                                            color={entry.enabled === false ? theme.colors.text.secondary : theme.colors.state.success.foreground}
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
                            icon={<Icon name="plus-circle" size={29} color={theme.colors.text.secondary} />}
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
                                        borderColor: theme.colors.border.default,
                                        borderRadius: 12,
                                        padding: 12,
                                        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                                    }}
                                >
                                    <Text style={{ fontSize: 12, color: theme.colors.text.secondary }}>
                                        {t('subAgentGuidance.settings.preview.systemPromptLabel')}
                                    </Text>
                                    <Text
                                        style={{
                                            marginTop: 8,
                                            fontSize: 12,
                                            color: theme.colors.text.primary,
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
                </>
            ) : (
                <ItemGroup
                    title={t('subAgentGuidance.settings.groupTitle')}
                    footer={t('subAgentGuidance.settings.disabled.footer')}
                >
                    <Item
                        title={t('subAgentGuidance.settings.disabled.enableExecutionRuns.title')}
                        subtitle={t('subAgentGuidance.settings.disabled.enableExecutionRuns.subtitle')}
                        icon={<Icon name="flask" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => router.push(SETTINGS_ROUTES.features)}
                    />
                </ItemGroup>
            )}

            {agentSubagentSections.map(({ agent, section }) => (
                <ItemGroup
                    key={`${agent.pluginId}:${agent.localId}:${section.id}`}
                    title={resolveText(section.title) ?? ''}
                    footer={resolveText(section.description)}
                >
                    {section.items.map((item) => (
                        <Item
                            key={`${agent.pluginId}:${agent.localId}:${section.id}:${item.id}`}
                            title={resolveText(item.title) ?? ''}
                            subtitle={resolveText(item.description)}
                            icon={<Icon name={(item.iconIonName as any) ?? 'sliders-horizontal'} size={29} color={theme.colors.accent.orange} />}
                            onPress={() => router.push(createPluginAgentSettingsRoute(agent) as never)}
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});
