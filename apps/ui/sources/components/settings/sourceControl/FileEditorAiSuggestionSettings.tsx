import * as React from 'react';
import type { FilesEditorAiSuggestionsV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveProviderModelPickerVisibility } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { StringListField } from '@/components/ui/forms/StringListField';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useSetting } from '@/sync/domains/state/storage';
import { fileEditorAiSuggestionUsageState } from '@/sync/domains/state/filePaneUiState';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { selectFileEditorAiSuggestionUsage, EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useProviderConnectionModels } from '@/providers/hooks/useProviderConnectionModels';
import { readProviderConnectionPickerKind, readAccountProviderDeclaration } from '@/providers/catalog/accountProviderDeclarations';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { fileEditorAiSuggestionNeedsAllowance, isFileEditorAiSuggestionModel } from '@/providers/models/fileEditorAiSuggestionModel';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';

const rows = SOURCE_CONTROL_SETTINGS.settings;
/** A model that only lacks an output allowance stays listed; choosing it opens that allowance instead of selecting it. */
const NEEDS_ALLOWANCE_PREFIX = 'needs-allowance:';

function PolicyStringList(props: Readonly<{ setting: SettingRef; values: string[] }>) {
    const { setSetting } = useSettingActionFeedback();
    const [draft, setDraft] = React.useState(props.values);
    const latest = React.useRef(draft);
    React.useEffect(() => { latest.current = props.values; setDraft(props.values); }, [props.values]);
    const label = t(props.setting.titleKey);
    return <SettingRow setting={props.setting} accessoryLayout="stacked" showChevron={false}
        rightElement={<StringListField testID={props.setting.anchor} values={draft}
            onChange={(next) => { latest.current = next; setDraft(next); }}
            onCommit={() => { void setSetting(props.setting, latest.current.map(value => value.trim()).filter(Boolean)); }}
            itemLabel={(position) => `${label} ${position}`} removeLabel={() => t('common.remove')}
            addLabel={t('common.add')} monospace />} />;
}

function AiSuggestionUsageRow() {
    const scope = useAccountSettingsScope();
    const key = scope ? serverAccountScopeKeySuffix(scope) : null;
    const stored = usePersistentUiStateValue(fileEditorAiSuggestionUsageState, key);
    const usage = key && stored ? selectFileEditorAiSuggestionUsage({ [key]: stored }, key) : EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE;
    const cost = usage.costReports > 0
        ? `${t('files.editing.aiSuggestions.reportedCost')}: ${formatUsageCost(usage.reportedCostUsd, 'USD')}`
        : t('files.editing.aiSuggestions.noCost');
    return <SettingRow setting={rows.aiSuggestionsUsage} detail={usage.requested.toLocaleString()}
        subtitle={cost} showChevron={false} />;
}

type ModelRows = ReturnType<typeof useProviderConnectionModels>['models'];

/**
 * Next edits (P7-R33) use their own model on the same source as ghost text (`nextEditModelId`), chosen
 * only from models whose catalog declares the next-edit operation. Without a choice, the ghost-text
 * model serves only if it declares that operation itself. The switch row says which model will predict
 * edits, or why none can, and stays switchable off.
 */
function NextEditRows(props: Readonly<{
    policy: FilesEditorAiSuggestionsV1; models: ModelRows; loading: boolean; sourceName: string | undefined; machineReady: boolean;
    onToggle(value: boolean): void; onSelect(modelId: string): void; onOpenAllowance(modelId: string): void;
}>) {
    const [open, setOpen] = React.useState(false);
    const { policy, models } = props;
    const descriptorOf = (id: string | null) => (id ? models.find(row => row.id === id && !row.stale)?.descriptor ?? null : null);
    const eligible = models.filter(row => !row.stale && row.descriptor && isFileEditorAiSuggestionModel(row.descriptor, 'nextEdit'));
    const repairable = models.filter(row => !row.stale && row.descriptor && fileEditorAiSuggestionNeedsAllowance(row.descriptor, 'nextEdit'));
    const chosen = descriptorOf(policy.nextEditModelId);
    const inherited = !policy.nextEditModelId ? descriptorOf(policy.modelId) : null;
    const effective = chosen && isFileEditorAiSuggestionModel(chosen, 'nextEdit') ? chosen
        : inherited && isFileEditorAiSuggestionModel(inherited, 'nextEdit') ? inherited : null;
    const known = !props.loading || models.length > 0;
    const none = known && Boolean(policy.connectionId) && !eligible.length && !repairable.length;
    const subtitle = !policy.connectionId ? t('files.editing.aiSuggestions.nextEditNeedsModel')
        : !known ? undefined
            : effective ? (policy.nextEditEnabled ? t('files.editing.aiSuggestions.nextEditReady', { model: effective.name }) : undefined)
                : none ? t('files.editing.aiSuggestions.nextEditNoneOnSource', { source: props.sourceName ?? '' })
                    : t('files.editing.aiSuggestions.nextEditChooseModel');
    const locked = !policy.nextEditEnabled && none;
    const items = open ? [
        ...eligible.map(row => ({ id: row.id, title: row.descriptor?.name ?? row.name ?? row.id })),
        ...repairable.map(row => ({ id: `${NEEDS_ALLOWANCE_PREFIX}${row.id}`, title: row.descriptor?.name ?? row.name ?? row.id,
            subtitle: t('files.editing.aiSuggestions.needsAllowance') })),
    ] : [];
    return <>
        <SettingRow setting={rows.aiSuggestionsNextEdit} subtitle={subtitle} showChevron={false} disabled={locked}
            onPress={locked ? undefined : () => props.onToggle(!policy.nextEditEnabled)}
            rightElement={<Switch value={policy.nextEditEnabled} disabled={locked} onValueChange={props.onToggle} />} />
        <SettingAnchor setting={rows.aiSuggestionsNextEditModel}>
            <DropdownMenu open={open} onOpenChange={setOpen} items={items} selectedId={effective?.id ?? null}
                search searchPlaceholder={t('files.editing.aiSuggestions.searchModels')}
                emptyLabel={props.loading ? t('common.loading') : t('files.editing.aiSuggestions.nextEditChooseModel')}
                itemTrigger={{ title: t(rows.aiSuggestionsNextEditModel.titleKey),
                    detailFormatter: () => effective?.name ?? (policy.nextEditModelId && props.loading ? t('common.loading') : t('files.editing.aiSuggestions.choose')),
                    itemProps: { testID: rows.aiSuggestionsNextEditModel.anchor, accessoryLayout: 'adaptive',
                        disabled: !policy.connectionId || !props.machineReady || none } }}
                onSelect={(id) => {
                    setOpen(false);
                    if (id.startsWith(NEEDS_ALLOWANCE_PREFIX)) { props.onOpenAllowance(id.slice(NEEDS_ALLOWANCE_PREFIX.length)); return; }
                    props.onSelect(id);
                }} />
        </SettingAnchor>
    </>;
}

/** Settings shell composition over the Account policy and existing non-Agent Provider catalogs. */
export function FileEditorAiSuggestionSettings(props: Readonly<{ machineId: string | null; serverId: string | null; active?: boolean }>) {
    const presented = useLayoutPresentationActive();
    const active = presented && props.active !== false;
    const policy = useSetting('filesEditorAiSuggestionsV1');
    const { setSetting } = useSettingActionFeedback();
    const [sourceOpen, setSourceOpen] = React.useState(false);
    const [modelOpen, setModelOpen] = React.useState(false);
    const router = useRouter();
    // The rows name the saved provider and model on first paint, so both reads follow the page's
    // presentation, not the dropdowns: one read per mount, shared with the opened menus.
    const sources = useProviderConnections({ enabled: true, active,
        machineId: props.machineId, serverId: props.serverId });
    const models = useProviderConnectionModels({ enabled: Boolean(policy.connectionId && props.machineId),
        active, machineId: props.machineId, serverId: props.serverId,
        connectionId: policy.connectionId ?? '' });
    const offeredSources = sourceOpen ? (sources.data?.connections ?? []).flatMap(connection => {
        const saved = sources.catalog?.connections.find(candidate => candidate.id === connection.connectionId);
        const kind = readProviderConnectionPickerKind(saved?.source, sources.declarationContext);
        const operations = connection.contributionKey
            ? readAccountProviderDeclaration(connection.contributionKey, sources.declarationContext)?.definition.inlineCompletion : null;
        if (!operations?.length) return [];
        if (!kind || !resolveProviderModelPickerVisibility({ connectionId: connection.connectionId, kind,
            modelPickerVisibilityByConnectionId: sources.catalog?.modelPickerVisibilityByConnectionId }).shown) return [];
        return [{ id: connection.connectionId, title: connection.displayName, disabled: !connection.authorized,
            subtitle: kind === 'local' ? t('files.editing.aiSuggestions.recommended') : undefined }];
    }) : [];
    const offeredModels = modelOpen ? models.models.filter(row => !row.stale && row.descriptor && isFileEditorAiSuggestionModel(row.descriptor))
        .map(row => ({ id: row.id, title: row.descriptor?.name ?? row.name ?? row.id,
            subtitle: row.descriptor?.costTier === 'low' ? t('files.editing.aiSuggestions.recommended') : undefined })) : [];
    const needAllowance = modelOpen ? models.models.filter(row => !row.stale && row.descriptor && fileEditorAiSuggestionNeedsAllowance(row.descriptor))
        .map(row => ({ id: `${NEEDS_ALLOWANCE_PREFIX}${row.id}`, title: row.descriptor?.name ?? row.name ?? row.id,
            subtitle: t('files.editing.aiSuggestions.needsAllowance') })) : [];
    const openAllowance = (modelId: string) => {
        setModelOpen(false);
        if (policy.connectionId) router.push(`/(app)/settings/providers/${encodeURIComponent(policy.connectionId)}/models?allowanceFor=${encodeURIComponent(modelId)}`);
    };
    const sourceName = sources.data?.connections.find(connection => connection.connectionId === policy.connectionId)?.displayName;
    const selectedModel = models.models.find(model => model.id === policy.modelId)?.descriptor;
    const modelName = selectedModel?.name;
    const update = (setting: SettingRef, value: string | boolean) => { void setSetting(setting, value); };
    // A saved choice whose name has not arrived yet reads as loading, never as "Choose…" (unset).
    // The section says what it is; the first row says what turning it on sends (one message each).
    return <ItemGroup title={t('files.editing.aiSuggestions.title')} description={t('files.editing.aiSuggestions.sectionDescription')}>
        <SettingRow setting={rows.aiSuggestionsEnabled} showChevron={false}
            onPress={() => { void setSetting(rows.aiSuggestionsEnabled, !policy.enabled).then(ok => {
                if (ok && !policy.enabled && !policy.connectionId) setSourceOpen(true);
            }); }}
            rightElement={<Switch value={policy.enabled} onValueChange={(enabled) => {
                void setSetting(rows.aiSuggestionsEnabled, enabled).then(ok => {
                    if (ok && enabled && !policy.connectionId) setSourceOpen(true);
                });
            }} />} />
        <SettingAnchor setting={rows.aiSuggestionsProvider}>
            <DropdownMenu open={sourceOpen} onOpenChange={setSourceOpen} items={offeredSources}
                selectedId={policy.connectionId} search searchPlaceholder={t('files.editing.aiSuggestions.searchProviders')} emptyLabel={sources.loading ? t('common.loading') : t('files.editing.aiSuggestions.modelUnavailable')}
                itemTrigger={{ title: t(rows.aiSuggestionsProvider.titleKey), detailFormatter: () => sourceName ?? (policy.connectionId && sources.loading ? t('common.loading') : t('files.editing.aiSuggestions.choose')),
                    itemProps: { testID: rows.aiSuggestionsProvider.anchor, accessoryLayout: 'adaptive' } }}
                onSelect={(id) => { if (offeredSources.find(source => source.id === id)?.disabled) return;
                    void setSetting(rows.aiSuggestionsProvider, id).then(ok => { if (ok) { setSourceOpen(false); setModelOpen(true); } }); }} />
        </SettingAnchor>
        <SettingAnchor setting={rows.aiSuggestionsModel}>
            <DropdownMenu open={modelOpen} onOpenChange={setModelOpen} items={[...offeredModels, ...needAllowance]}
                selectedId={policy.modelId} search searchPlaceholder={t('files.editing.aiSuggestions.searchModels')} emptyLabel={models.loading ? t('common.loading') : t('files.editing.aiSuggestions.modelUnavailable')}
                itemTrigger={{ title: t(rows.aiSuggestionsModel.titleKey), detailFormatter: () => modelName ?? (policy.modelId && models.loading ? t('common.loading') : t('files.editing.aiSuggestions.choose')),
                    itemProps: { testID: rows.aiSuggestionsModel.anchor, disabled: !policy.connectionId || !props.machineId, accessoryLayout: 'adaptive' } }}
                onSelect={(id) => {
                    if (id.startsWith(NEEDS_ALLOWANCE_PREFIX)) { openAllowance(id.slice(NEEDS_ALLOWANCE_PREFIX.length)); return; }
                    void setSetting(rows.aiSuggestionsModel, id).then(ok => { if (ok) setModelOpen(false); });
                }} />
        </SettingAnchor>
        <NextEditRows policy={policy} models={models.models} loading={models.loading} sourceName={sourceName} machineReady={Boolean(props.machineId)}
            onToggle={value => update(rows.aiSuggestionsNextEdit, value)} onSelect={id => update(rows.aiSuggestionsNextEditModel, id)}
            onOpenAllowance={openAllowance} />
        <SettingAnchor setting={rows.aiSuggestionsMode}>
            <SegmentedChoiceItem<FilesEditorAiSuggestionsV1['mode']> title={t(rows.aiSuggestionsMode.titleKey)}
                testIDPrefix={rows.aiSuggestionsMode.anchor} value={policy.mode} onChange={value => update(rows.aiSuggestionsMode, value)}
                options={[{ id: 'automatic', label: t('files.editing.aiSuggestions.automatic') }, { id: 'onRequest', label: t('files.editing.aiSuggestions.onRequest'), description: 'Alt+\\' }]} />
        </SettingAnchor>
        <SettingAnchor setting={rows.aiSuggestionsDelay}>
            <SegmentedChoiceItem<FilesEditorAiSuggestionsV1['delay']> title={t(rows.aiSuggestionsDelay.titleKey)}
                testIDPrefix={rows.aiSuggestionsDelay.anchor} value={policy.delay} onChange={value => update(rows.aiSuggestionsDelay, value)}
                options={[{ id: 'fast', label: t('files.editing.aiSuggestions.fast') }, { id: 'normal', label: t('files.editing.aiSuggestions.normal') }, { id: 'relaxed', label: t('files.editing.aiSuggestions.relaxed') }]} />
        </SettingAnchor>
        <PolicyStringList setting={rows.aiSuggestionsExcluded} values={policy.excludedGlobs} />
        <PolicyStringList setting={rows.aiSuggestionsDisabledLanguages} values={policy.disabledLanguageIds} />
        <AiSuggestionUsageRow />
    </ItemGroup>;
}
