import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ApiTokenGrantV1 } from '@happier-dev/protocol';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { actionIdFamilyTitleKey, ACTION_SETTINGS_FAMILY_TITLE_KEYS } from '@/components/settings/actions/actionSettingsFamily';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StepTransitionFrame } from '@/components/ui/motion';
import { SelectionListBackChip } from '@/components/ui/selectionList/SelectionListBackChip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useAllSessions } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import {
    addApiTokenGrantOrigin,
    apiTokenGrantModelKey,
    readApiTokenGrantOriginInput,
    removeApiTokenGrantOrigin,
    resolveApiTokenGrantDraftIssues,
    setApiTokenGrantAllActions,
    setApiTokenGrantAllTargets,
    setApiTokenGrantAnyModel,
    setApiTokenGrantApprove,
    toggleApiTokenGrantActionId,
    toggleApiTokenGrantFamily,
    toggleApiTokenGrantModel,
    toggleApiTokenGrantTarget,
} from './apiTokenGrantDraft';
import { buildApiTokenGrantModelOptions } from './apiTokenGrantCatalog';
import {
    useApiTokenGrantActionGroups,
    useApiTokenGrantModelAgents,
    useApiTokenGrantModelMachine,
    useApiTokenGrantNames,
    useApiTokenGrantProviderModelGroups,
    type ApiTokenGrantModelAgent,
} from './useApiTokenGrantCatalogs';
import { formatApiTokenAccessSummary, buildApiTokenAccessSummaryParts } from '../apiTokenSettingsPresentation';

/**
 * The one grant editor for API tokens (plan 01 §6.3). It edits a complete `ApiTokenGrantV1`: Settings
 * → API tokens uses it whole; Settings → Embeds composes its parts (websites, models, approve) into
 * its own sections. Rows are value summaries that push their picker inside the same container, so
 * it works in a modal and on a page alike; fields it does not show (`permissionModes`, `create`) pass
 * through untouched.
 */

export type ApiTokenGrantPicker = 'actions' | 'targets' | 'models';

export type ApiTokenGrantEditorProps = Readonly<{
    value: ApiTokenGrantV1;
    onChange: (next: ApiTokenGrantV1) => void;
    /**
     * The open picker, held by the container whose footer it changes: while a picker is open the
     * container's primary action is that picker's Done (`ApiTokenGrantPickerDone`, lab T4–T6).
     */
    picker: ApiTokenGrantPicker | null;
    onPickerChange: (picker: ApiTokenGrantPicker | null) => void;
    disabled?: boolean;
    /** Read back in the review line ("Leads dashboard can …"). */
    label: string;
    /** When the token will expire, as the review line states it; null omits it. */
    expiresAt: string | null;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    stack: {
        gap: 20,
    },
    pickerHead: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    review: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13.5,
        lineHeight: 20,
        paddingHorizontal: 2,
    },
    reviewLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    addRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    addField: {
        flex: 1,
        minWidth: 0,
    },
    search: {
        marginBottom: 10,
    },
}));

/** The open grant picker of one container; its footer reads it to show the picker's Done. */
export function useApiTokenGrantPicker() {
    const [picker, setPicker] = React.useState<ApiTokenGrantPicker | null>(null);
    const close = React.useCallback(() => setPicker(null), []);
    return { picker, setPicker, close } as const;
}

/** A picker's Done: the container's one primary while the picker is open. Selections already live in the draft. */
export function ApiTokenGrantPickerDone(props: Readonly<{ onPress: () => void }>) {
    return <RoundButton size="normal" title={t('common.done')} testID="api-token-grant-picker-done" onPress={props.onPress} />;
}

export const ApiTokenGrantEditor = React.memo(function ApiTokenGrantEditor(props: ApiTokenGrantEditorProps) {
    const { picker, onPickerChange } = props;
    const styles = stylesheet;
    const close = React.useCallback(() => onPickerChange(null), [onPickerChange]);
    const testID = props.testID ?? 'api-token-grant-editor';

    return (
        <StepTransitionFrame transitionKey={picker ?? 'summary'} direction={picker ? 'forward' : 'backward'} testID={testID}>
            {picker === null ? (
                <View style={styles.stack}>
                    <ApiTokenGrantAccessSection
                        value={props.value}
                        onChange={props.onChange}
                        disabled={props.disabled}
                        onOpenPicker={onPickerChange}
                    />
                    <ApiTokenGrantWebsitesSection value={props.value} onChange={props.onChange} disabled={props.disabled} />
                    <ApiTokenGrantReview value={props.value} label={props.label} expiresAt={props.expiresAt} />
                </View>
            ) : (
                <View style={styles.stack}>
                    <View style={styles.pickerHead}>
                        <SelectionListBackChip label={t('settingsApiTokens.grant.back')} onPress={close} testID={`${testID}-back`} />
                    </View>
                    {picker === 'actions' ? <ApiTokenGrantActionsPicker value={props.value} onChange={props.onChange} disabled={props.disabled} /> : null}
                    {picker === 'targets' ? <ApiTokenGrantTargetsPicker value={props.value} onChange={props.onChange} disabled={props.disabled} /> : null}
                    {picker === 'models' ? <ApiTokenGrantModelsPicker value={props.value} onChange={props.onChange} disabled={props.disabled} /> : null}
                </View>
            )}
        </StepTransitionFrame>
    );
});

type GrantPartProps = Readonly<{
    value: ApiTokenGrantV1;
    onChange: (next: ApiTokenGrantV1) => void;
    disabled?: boolean;
}>;

/** Actions, reach and models as value summaries, then the Approve switch. */
const ApiTokenGrantAccessSection = React.memo(function ApiTokenGrantAccessSection(props: GrantPartProps & Readonly<{
    onOpenPicker: (picker: ApiTokenGrantPicker) => void;
}>) {
    const names = useApiTokenGrantNames();
    const issues = resolveApiTokenGrantDraftIssues(props.value);
    const { actions, targets, models } = props.value;
    const actionsSummary = actions === null
        ? t('settingsApiTokens.grant.actions.all')
        : issues.includes('actions_required')
            ? t('settingsApiTokens.grant.actions.none')
            : summarizeNames([
                ...actions.families.map((family) => names.familyName(family) ?? family),
                ...actions.ids.map((id) => names.actionName(id) ?? id),
            ]);
    const targetsSummary = targets === null
        ? t('settingsApiTokens.grant.targets.all')
        : issues.includes('targets_required')
            ? t('settingsApiTokens.grant.targets.none')
            : [
                targets.sessions.length > 0 ? t('settingsApiTokens.summary.sessions', { count: targets.sessions.length }) : null,
                targets.machines.length > 0 ? t('settingsApiTokens.summary.computers', { count: targets.machines.length }) : null,
            ].filter(Boolean).join(' · ');
    const modelsSummary = models === null
        ? t('settingsApiTokens.grant.models.any')
        : issues.includes('models_required')
            ? t('settingsApiTokens.grant.models.none')
            : summarizeNames(models.map((ref) => names.modelName(ref) ?? ref.modelId));

    return (
        <ItemGroup title={t('settingsApiTokens.grant.accessTitle')}>
            <Item
                testID="api-token-grant-actions"
                title={t('settingsApiTokens.grant.actions.title')}
                subtitle={actionsSummary}
                onPress={() => props.onOpenPicker('actions')}
                disabled={props.disabled}
            />
            <Item
                testID="api-token-grant-targets"
                title={t('settingsApiTokens.grant.targets.title')}
                subtitle={targetsSummary}
                onPress={() => props.onOpenPicker('targets')}
                disabled={props.disabled}
            />
            <Item
                testID="api-token-grant-models"
                title={t('settingsApiTokens.grant.models.title')}
                subtitle={modelsSummary}
                onPress={() => props.onOpenPicker('models')}
                disabled={props.disabled}
            />
            <ApiTokenGrantApproveRow value={props.value} onChange={props.onChange} disabled={props.disabled} />
        </ItemGroup>
    );
});

function summarizeNames(names: readonly string[]): string {
    if (names.length <= 2) return names.join(', ');
    return t('settingsApiTokens.summary.namesAndMore', { names: names.slice(0, 2).join(', '), count: names.length - 2 });
}

/** Approve requests: off by default; when on, the consequence is stated in full (R-APPROVE). */
export const ApiTokenGrantApproveRow = React.memo(function ApiTokenGrantApproveRow(props: GrantPartProps & Readonly<{
    /** The consequence while approving is on, in the words of the surface that owns the token (an embed). */
    onDescription?: string;
}>) {
    return (
        <Item
            testID="api-token-grant-approve"
            title={t('settingsApiTokens.grant.approve.title')}
            subtitle={props.value.approve ? props.onDescription ?? t('settingsApiTokens.grant.approve.on') : t('settingsApiTokens.grant.approve.off')}
            subtitleLines={0}
            // The consequence changes with the switch; a screen reader hears it.
            accessibilityLiveRegion="polite"
            rightElement={(
                <Switch
                    testID="api-token-grant-approve-switch"
                    accessibilityLabel={t('settingsApiTokens.grant.approve.title')}
                    value={props.value.approve}
                    disabled={props.disabled}
                    onValueChange={(approve) => props.onChange(setApiTokenGrantApprove(props.value, approve))}
                />
            )}
            showChevron={false}
        />
    );
});

/** The sites whose pages may use the token from a browser, with inline add and calm validation. */
export const ApiTokenGrantWebsitesSection = React.memo(function ApiTokenGrantWebsitesSection(props: GrantPartProps & Readonly<{
    title?: string;
    description?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [input, setInput] = React.useState('');
    const [error, setError] = React.useState<'invalid' | 'duplicate' | null>(null);
    const add = React.useCallback(() => {
        const result = readApiTokenGrantOriginInput(input, props.value.origins);
        if (!result.ok) {
            setError(result.reason === 'empty' ? null : result.reason);
            return;
        }
        props.onChange(addApiTokenGrantOrigin(props.value, result.origin));
        setInput('');
        setError(null);
    }, [input, props]);

    return (
        <ItemGroup
            title={props.title ?? t('settingsApiTokens.grant.websites.title')}
            description={props.description ?? t('settingsApiTokens.grant.websites.description')}
        >
            {props.value.origins.map((origin) => (
                <Item
                    key={origin}
                    testID={`api-token-grant-origin:${origin}`}
                    title={origin}
                    titleStyle={{ ...Typography.mono(), fontSize: 13 }}
                    icon={<Icon name="globe" size={18} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <IconButton
                            testID={`api-token-grant-origin-remove:${origin}`}
                            iconName="x"
                            variant="plain"
                            accessibilityLabel={t('settingsApiTokens.grant.websites.remove', { origin })}
                            disabled={props.disabled}
                            onPress={() => props.onChange(removeApiTokenGrantOrigin(props.value, origin))}
                        />
                    )}
                    mode="info"
                    showChevron={false}
                />
            ))}
            <Item
                title={t('settingsApiTokens.grant.websites.inputLabel')}
                accessoryLayout="stacked"
                rightElement={(
                    <View style={styles.addRow}>
                        <View style={styles.addField}>
                            <FieldTextInput
                                testID="api-token-grant-origin-input"
                                value={input}
                                onChangeText={(next) => {
                                    setInput(next);
                                    if (error) setError(null);
                                }}
                                accessibilityLabel={t('settingsApiTokens.grant.websites.inputLabel')}
                                placeholder={t('settingsApiTokens.grant.websites.placeholder')}
                                error={error === 'invalid'
                                    ? t('settingsApiTokens.grant.websites.invalid')
                                    : error === 'duplicate'
                                        ? t('settingsApiTokens.grant.websites.duplicate')
                                        : null}
                                autoCapitalize="none"
                                keyboardType="url"
                                inputMode="url"
                                monospace
                                editable={!props.disabled}
                                returnKeyType="done"
                                onSubmitEditing={add}
                            />
                        </View>
                        <RoundButton
                            testID="api-token-grant-origin-add"
                            size="small"
                            display="secondary"
                            title={t('settingsApiTokens.grant.websites.add')}
                            disabled={props.disabled || input.trim().length === 0}
                            onPress={add}
                        />
                    </View>
                )}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
});

function ApiTokenGrantReview(props: Readonly<{ value: ApiTokenGrantV1; label: string; expiresAt: string | null }>) {
    const styles = stylesheet;
    const names = useApiTokenGrantNames();
    const summary = formatApiTokenAccessSummary(buildApiTokenAccessSummaryParts({
        token: { grant: props.value, expiresAt: props.expiresAt, hasEncryptionAccess: false },
        nowMs: Date.now(),
        names,
    }));
    const label = props.label.trim() || t('settingsApiTokens.grant.reviewUnnamed');
    return (
        <Text style={styles.review} testID="api-token-grant-review" accessibilityLiveRegion="polite">
            <Text style={styles.reviewLabel}>{label}</Text>
            {` · ${summary}`}
        </Text>
    );
}

/** A choice row with a checkbox on the right: one family, action, session, computer or model. */
function CheckRow(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string | null;
    checked: boolean;
    disabled?: boolean;
    icon?: React.ReactNode;
    onToggle: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={props.subtitle ?? undefined}
            icon={props.icon}
            accessibilityRole="checkbox"
            accessibilityChecked={props.checked}
            rightElement={(
                <Icon
                    name={props.checked ? 'check-square' : 'square'}
                    size={20}
                    color={props.checked ? theme.colors.accent.blue : theme.colors.text.secondary}
                />
            )}
            disabled={props.disabled}
            onPress={props.onToggle}
            showChevron={false}
        />
    );
}

/** "Every …" or "Only these": the scope choice every picker opens with (the canonical radio rows). */
function ScopeChoice(props: Readonly<{
    testIDPrefix: string;
    allTitle: string;
    onlyTitle: string;
    onlySubtitle: string | null;
    all: boolean;
    disabled?: boolean;
    onChange: (all: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const selectedMark = <Icon name="check" size={16} color={theme.colors.text.primary} />;
    return (
        <ItemGroup accessibilityRole="radiogroup" accessibilityLabel={props.onlyTitle}>
            <Item
                testID={`${props.testIDPrefix}-all`}
                title={props.allTitle}
                accessibilityRole="radio"
                webRole="radio"
                selected={props.all}
                rightElement={props.all ? selectedMark : undefined}
                disabled={props.disabled}
                onPress={() => props.onChange(true)}
                showChevron={false}
            />
            <Item
                testID={`${props.testIDPrefix}-only`}
                title={props.onlyTitle}
                subtitle={props.onlySubtitle ?? undefined}
                accessibilityRole="radio"
                webRole="radio"
                selected={!props.all}
                rightElement={!props.all ? selectedMark : undefined}
                disabled={props.disabled}
                onPress={() => props.onChange(false)}
                showChevron={false}
            />
        </ItemGroup>
    );
}

export const ApiTokenGrantActionsPicker = React.memo(function ApiTokenGrantActionsPicker(props: GrantPartProps) {
    const styles = stylesheet;
    const groups = useApiTokenGrantActionGroups();
    const [query, setQuery] = React.useState('');
    const actions = props.value.actions;
    const normalized = query.trim().toLowerCase();
    const matches = (text: string) => normalized.length === 0 || text.toLowerCase().includes(normalized);
    const visibleGroups = groups.map((group) => ({
        ...group,
        families: group.families.filter((entry) => matches(t(actionIdFamilyTitleKey(entry.family)))),
        actions: group.actions.filter((action) => matches(`${action.title} ${action.description ?? ''} ${action.id}`)),
    })).filter((group) => group.families.length > 0 || group.actions.length > 0);
    const chosen = actions ? actions.families.length + actions.ids.length : 0;

    return (
        <>
            <ScopeChoice
                testIDPrefix="api-token-grant-actions-scope"
                allTitle={t('settingsApiTokens.grant.actions.all')}
                onlyTitle={t('settingsApiTokens.grant.onlyThese')}
                onlySubtitle={actions ? t('settingsApiTokens.grant.selectedCount', { count: chosen }) : null}
                all={actions === null}
                disabled={props.disabled}
                onChange={(all) => props.onChange(setApiTokenGrantAllActions(props.value, all))}
            />
            {actions ? (
                <>
                    <CompactSearchField
                        testID="api-token-grant-actions-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('settingsApiTokens.grant.actions.search')}
                        style={styles.search}
                    />
                    {visibleGroups.length === 0 ? (
                        <ItemGroup>
                            <Item title={t('settingsApiTokens.grant.actions.noMatches', { query: query.trim() })} mode="info" showChevron={false} />
                        </ItemGroup>
                    ) : null}
                    {visibleGroups.map((group) => (
                        <ItemGroup
                            key={group.settingsFamily}
                            title={t(ACTION_SETTINGS_FAMILY_TITLE_KEYS[group.settingsFamily])}
                            description={t('settingsApiTokens.grant.actions.groupDescription')}
                        >
                            {group.families.map((entry) => (
                                <CheckRow
                                    key={`family:${entry.family}`}
                                    testID={`api-token-grant-family:${entry.family}`}
                                    title={t(actionIdFamilyTitleKey(entry.family))}
                                    subtitle={t('settingsApiTokens.grant.actions.familyCount', { count: entry.actionCount })}
                                    checked={actions.families.includes(entry.family)}
                                    disabled={props.disabled}
                                    onToggle={() => props.onChange(toggleApiTokenGrantFamily(props.value, entry.family))}
                                />
                            ))}
                            {group.actions.map((action) => {
                                const coveredByFamily = action.family !== null && actions.families.includes(action.family);
                                return (
                                    <CheckRow
                                        key={`action:${action.id}`}
                                        testID={`api-token-grant-action:${action.id}`}
                                        title={action.title}
                                        subtitle={coveredByFamily
                                            ? t('settingsApiTokens.grant.actions.includedByFamily', { family: t(actionIdFamilyTitleKey(action.family!)) })
                                            : action.description}
                                        checked={coveredByFamily || actions.ids.includes(action.id)}
                                        disabled={props.disabled || coveredByFamily}
                                        onToggle={() => props.onChange(toggleApiTokenGrantActionId(props.value, action.id))}
                                    />
                                );
                            })}
                        </ItemGroup>
                    ))}
                </>
            ) : null}
        </>
    );
});

export const ApiTokenGrantTargetsPicker = React.memo(function ApiTokenGrantTargetsPicker(props: GrantPartProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const machines = useAllMachines();
    const sessions = useAllSessions();
    const [query, setQuery] = React.useState('');
    const targets = props.value.targets;
    const normalized = query.trim().toLowerCase();
    const machineNames = React.useMemo(() => new Map(machines.map((machine) => [machine.id, getMachineDisplayName(machine) ?? machine.id])), [machines]);
    const sessionRows = React.useMemo(() => sessions.map((session) => ({
        id: session.id,
        title: getSessionName(session),
        machineName: session.metadata?.machineId ? machineNames.get(session.metadata.machineId) ?? null : null,
    })), [machineNames, sessions]);
    const visibleSessions = normalized.length === 0
        ? sessionRows
        : sessionRows.filter((row) => `${row.title} ${row.machineName ?? ''}`.toLowerCase().includes(normalized));
    const chosen = targets ? targets.sessions.length + targets.machines.length : 0;

    return (
        <>
            <ScopeChoice
                testIDPrefix="api-token-grant-targets-scope"
                allTitle={t('settingsApiTokens.grant.targets.all')}
                onlyTitle={t('settingsApiTokens.grant.onlyThese')}
                onlySubtitle={targets ? t('settingsApiTokens.grant.selectedCount', { count: chosen }) : null}
                all={targets === null}
                disabled={props.disabled}
                onChange={(all) => props.onChange(setApiTokenGrantAllTargets(props.value, all))}
            />
            {targets ? (
                <>
                    <ItemGroup title={t('settingsApiTokens.grant.targets.computers')} description={t('settingsApiTokens.grant.targets.computersDescription')}>
                        {machines.length === 0 ? (
                            <Item title={t('settingsApiTokens.grant.targets.noComputers')} mode="info" showChevron={false} />
                        ) : machines.map((machine) => (
                            <CheckRow
                                key={machine.id}
                                testID={`api-token-grant-machine:${machine.id}`}
                                title={machineNames.get(machine.id) ?? machine.id}
                                icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                                checked={targets.machines.includes(machine.id)}
                                disabled={props.disabled}
                                onToggle={() => props.onChange(toggleApiTokenGrantTarget(props.value, { kind: 'machine', machineId: machine.id }))}
                            />
                        ))}
                    </ItemGroup>
                    <ItemGroup title={t('settingsApiTokens.grant.targets.sessions')}>
                        {sessionRows.length > 0 ? (
                            <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
                                <CompactSearchField
                                    testID="api-token-grant-sessions-search"
                                    value={query}
                                    onChangeText={setQuery}
                                    placeholder={t('settingsApiTokens.grant.targets.searchSessions')}
                                    style={styles.search}
                                />
                            </View>
                        ) : null}
                        {sessionRows.length === 0 ? (
                            <Item title={t('settingsApiTokens.grant.targets.noSessions')} mode="info" showChevron={false} />
                        ) : visibleSessions.length === 0 ? (
                            <Item title={t('settingsApiTokens.grant.targets.noSessionMatches', { query: query.trim() })} mode="info" showChevron={false} />
                        ) : visibleSessions.map((row) => (
                            <CheckRow
                                key={row.id}
                                testID={`api-token-grant-session:${row.id}`}
                                title={row.title}
                                subtitle={row.machineName}
                                checked={targets.sessions.includes(row.id)}
                                disabled={props.disabled}
                                onToggle={() => props.onChange(toggleApiTokenGrantTarget(props.value, { kind: 'session', sessionId: row.id }))}
                            />
                        ))}
                    </ItemGroup>
                </>
            ) : null}
        </>
    );
});

export const ApiTokenGrantModelsPicker = React.memo(function ApiTokenGrantModelsPicker(props: GrantPartProps) {
    const models = props.value.models;
    const agents = useApiTokenGrantModelAgents(models);
    const machine = useApiTokenGrantModelMachine(props.value.create?.machineId ?? null);
    const selected = React.useMemo(() => new Set((models ?? []).map(apiTokenGrantModelKey)), [models]);

    return (
        <>
            <ScopeChoice
                testIDPrefix="api-token-grant-models-scope"
                allTitle={t('settingsApiTokens.grant.models.any')}
                onlyTitle={t('settingsApiTokens.grant.models.onlyThese')}
                onlySubtitle={models ? t('settingsApiTokens.grant.selectedCount', { count: models.length }) : null}
                all={models === null}
                disabled={props.disabled}
                onChange={(any) => props.onChange(setApiTokenGrantAnyModel(props.value, any))}
            />
            {models ? (
                agents.length === 0 ? (
                    <ItemGroup>
                        <Item title={t('settingsApiTokens.grant.models.noModels')} mode="info" showChevron={false} />
                    </ItemGroup>
                ) : agents.map((agent) => (
                    <ApiTokenGrantAgentModels
                        key={agent.agentTargetKey}
                        agent={agent}
                        machineId={machine.machineId}
                        serverId={machine.serverId}
                        selected={selected}
                        {...props}
                    />
                ))
            ) : null}
        </>
    );
});

/**
 * One Agent's choosable models: its native catalog models and the provider-connected models the
 * provider-model projection reports for it (full provider-bound refs). Mounted only while the
 * models picker is open, so the projection is read on demand.
 */
function ApiTokenGrantAgentModels(props: GrantPartProps & Readonly<{
    agent: ApiTokenGrantModelAgent;
    machineId: string | null;
    serverId: string | null;
    selected: ReadonlySet<string>;
}>) {
    const { theme } = useUnistyles();
    const providerGroups = useApiTokenGrantProviderModelGroups({
        agentTargetKey: props.agent.agentTargetKey,
        machineId: props.agent.entry ? props.machineId : null,
        serverId: props.serverId,
    });
    const options = React.useMemo(() => buildApiTokenGrantModelOptions({
        agentTargetKey: props.agent.agentTargetKey,
        nativeModels: props.agent.nativeModels,
        providerGroups,
        granted: props.value.models,
    }), [props.agent, providerGroups, props.value.models]);
    if (options.length === 0) return null;
    return (
        <ItemGroup title={props.agent.title} description={t('settingsApiTokens.grant.models.pickerDescription')}>
            {options.map((model) => (
                <CheckRow
                    key={model.key}
                    testID={`api-token-grant-model:${model.ref.modelId}`}
                    title={model.name}
                    subtitle={model.description}
                    icon={props.agent.entry ? (
                        <AgentCatalogIdentityIcon
                            entry={props.agent.entry.agentCatalogEntry}
                            machineId={null}
                            serverId={null}
                            current={false}
                            size={18}
                            color={theme.colors.text.secondary}
                        />
                    ) : undefined}
                    checked={props.selected.has(model.key)}
                    disabled={props.disabled}
                    onToggle={() => props.onChange(toggleApiTokenGrantModel(props.value, model.ref))}
                />
            ))}
        </ItemGroup>
    );
}
