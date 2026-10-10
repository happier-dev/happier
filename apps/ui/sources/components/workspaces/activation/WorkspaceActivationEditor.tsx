import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { computeWorkspaceSyncPolicyDigest, type HandoffWorkspaceActionV1, type WorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { MachineSelector, type MachineSelectorProps } from '@/components/sessions/new/components/MachineSelector';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathSelectionList, type PathSelectionListProps } from '@/components/ui/pathPicker/PathSelectionList';
import { Text } from '@/components/ui/text/Text';
import { WorkspaceSyncIgnoredIncludePatternsField } from '@/components/workspaces/sync/WorkspaceSyncIgnoredIncludePatternsField';
import {
    SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS,
    SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS,
    SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS,
    buildSessionHandoffWorkspaceAction,
    parseSessionHandoffIgnoredIncludeGlobs,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { t } from '@/text';

/** Destination identity and editable path belong to the same activation draft. */
export function WorkspaceActivationDestinationFields(props: Readonly<{
    machine: MachineSelectorProps;
    path: PathSelectionListProps;
    pathTitle: string;
    /**
     * A destination whose folder is not chosen here (a no-folder session keeps a private folder on
     * the target machine): shown as that fact instead of the path picker.
     */
    fixedFolderLabel?: string | null;
    disabled?: boolean;
    blockedReason?: string | null;
}>) {
    return (
        <View pointerEvents={props.disabled ? 'none' : 'auto'} importantForAccessibility={props.disabled ? 'no-hide-descendants' : 'auto'}>
            <MachineSelector {...props.machine} />
            <ItemGroup title={props.pathTitle} clipContent>
                {props.fixedFolderLabel
                    ? <Item testID="workspace-activation-fixed-folder" title={props.fixedFolderLabel} showChevron={false} />
                    : <PathSelectionList {...props.path} />}
            </ItemGroup>
            {props.blockedReason ? <Text accessibilityLiveRegion="polite">{props.blockedReason}</Text> : null}
        </View>
    );
}

export function WorkspaceActivationModeField(props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedId: string;
    title: string;
    subtitle: string;
    items: ReadonlyArray<{ id: string; title: string; subtitle: string }>;
    onSelect: (id: string) => void;
    testID?: string;
    disabled?: boolean;
    icon?: React.ReactNode;
}>) {
    return <DropdownMenu
        open={props.open}
        onOpenChange={props.onOpenChange}
        variant="selectable"
        search={false}
        selectedId={props.selectedId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        itemTrigger={{
            title: props.title,
            subtitle: props.subtitle,
            ...(props.icon ? { icon: props.icon } : {}),
            itemProps: { disabled: props.disabled, ...(props.testID ? { testID: props.testID } : {}) },
        }}
        items={props.items}
        onSelect={(id) => { if (!props.disabled) props.onSelect(id); }}
    />;
}

/** Raw comma-separated patterns remain a draft until the host submits its action. */
export function WorkspaceActivationContentPolicyFields(props: Readonly<{
    contentSelection: 'git_worktree' | 'all_files';
    onContentSelectionChange: (value: 'git_worktree' | 'all_files') => void;
    includeIgnoredMode: 'exclude' | 'include_selected';
    onIncludeIgnoredModeChange: (value: 'exclude' | 'include_selected') => void;
    patternsDraft: string;
    onPatternsDraftChange: (value: string) => void;
    disabled?: boolean;
    testIdPrefix?: string;
}>) {
    const { theme } = useUnistyles();
    const [openMenu, setOpenMenu] = React.useState<'content' | 'ignored' | null>(null);
    const selectedContent = SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS.find((option) => option.id === props.contentSelection)!;
    return <ItemGroup>
        <WorkspaceActivationModeField
            open={openMenu === 'content'} onOpenChange={(open) => setOpenMenu(open ? 'content' : null)}
            selectedId={props.contentSelection}
            title={t('settingsSession.handoff.contentSelection.title')}
            subtitle={t(selectedContent.subtitleKey)}
            icon={<Icon name="files" size={16} color={theme.colors.text.secondary} />}
            testID={props.testIdPrefix ? `${props.testIdPrefix}-content-selection-trigger` : undefined}
            disabled={props.disabled}
            items={SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS.map((option) => ({ id: option.id, title: t(option.titleKey), subtitle: t(option.subtitleKey) }))}
            onSelect={(id) => { props.onContentSelectionChange(id as 'git_worktree' | 'all_files'); setOpenMenu(null); }}
        />
        <WorkspaceActivationModeField
            open={openMenu === 'ignored'} onOpenChange={(open) => setOpenMenu(open ? 'ignored' : null)}
            selectedId={props.includeIgnoredMode}
            title={t('settingsSession.handoff.includeIgnoredMode.title')}
            subtitle={t('settingsSession.handoff.includeIgnoredMode.subtitle')}
            icon={<Icon name="funnel-simple" size={16} color={theme.colors.text.secondary} />}
            testID={props.testIdPrefix ? `${props.testIdPrefix}-ignored-mode-trigger` : undefined}
            disabled={props.disabled}
            items={SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.map((option) => ({ id: option.id, title: t(option.titleKey), subtitle: t(option.subtitleKey) }))}
            onSelect={(id) => { props.onIncludeIgnoredModeChange(id as 'exclude' | 'include_selected'); setOpenMenu(null); }}
        />
        {props.includeIgnoredMode === 'include_selected' ? <WorkspaceSyncIgnoredIncludePatternsField
            value={props.patternsDraft}
            onChangeText={props.onPatternsDraftChange}
            editable={!props.disabled}
        /> : null}
    </ItemGroup>;
}

/** Copy and relationship editing share the incumbent Sync action and content-policy fields. */
export function WorkspaceActivationSyncFields(props: Readonly<{
    action: HandoffWorkspaceActionV1;
    onChange: (action: HandoffWorkspaceActionV1) => void;
    disabled?: boolean;
    testIdPrefix?: string;
}>) {
    const action = props.action;
    const policy = action.kind === 'copy_once' || action.kind === 'create_relationship' ? action.contentPolicy : null;
    const hasIncludes = Boolean(policy?.extraIncludePatterns.length);
    const [open, setOpen] = React.useState(false);
    const [includeIgnoredMode, setIncludeIgnoredMode] = React.useState<'exclude' | 'include_selected'>(hasIncludes ? 'include_selected' : 'exclude');
    const [patternsDraft, setPatternsDraft] = React.useState(() => policy?.extraIncludePatterns.join(', ') ?? '');
    const patterns = policy?.extraIncludePatterns;
    React.useEffect(() => { setIncludeIgnoredMode(hasIncludes ? 'include_selected' : 'exclude'); }, [hasIncludes]);
    React.useEffect(() => {
        setPatternsDraft(current => {
            const parsed = parseSessionHandoffIgnoredIncludeGlobs(current);
            return parsed.length === (patterns?.length ?? 0) && parsed.every((value, index) => value === patterns?.[index])
                ? current : patterns?.join(', ') ?? '';
        });
    }, [patterns]);
    const selectedId = action.kind === 'create_relationship' ? action.mode : action.kind;
    const options = SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.filter(option => option.id !== 'none');
    const selected = options.find(option => option.id === selectedId);
    const updatePolicy = (patch: Partial<Omit<WorkspaceContentPolicyV1, 'policyDigest'>>) => {
        if (action.kind !== 'copy_once' && action.kind !== 'create_relationship') return;
        const { policyDigest: _digest, ...current } = action.contentPolicy;
        const next = { ...current, ...patch };
        props.onChange({ ...action, contentPolicy: { ...next, policyDigest: computeWorkspaceSyncPolicyDigest(next) } });
    };
    return <>
        <ItemGroup>
            <WorkspaceActivationModeField
                open={open} onOpenChange={setOpen}
                selectedId={selectedId}
                title={t('settingsSession.handoff.workspaceMode.title')}
                subtitle={selected ? t(selected.subtitleKey) : t('settingsSession.handoff.workspaceMode.relationshipSelected')}
                testID={props.testIdPrefix ? `${props.testIdPrefix}.sync-mode` : undefined}
                disabled={props.disabled}
                items={[
                    ...(!selected ? [{ id: selectedId, title: t('settingsSession.handoff.workspaceMode.relationshipTitle'),
                        subtitle: action.kind === 'relationship' ? action.relationshipId : t('settingsSession.handoff.workspaceMode.relationshipSelected') }] : []),
                    ...options.map(option => ({ id: option.id, title: t(option.titleKey), subtitle: t(option.subtitleKey) })),
                ]}
                onSelect={id => {
                    const option = options.find(candidate => candidate.id === id);
                    if (!option) return;
                    const next = buildSessionHandoffWorkspaceAction({ workspaceSyncMode: option.id,
                        contentSelection: policy?.selection ?? 'git_worktree', includeIgnoredMode,
                        ignoredIncludeGlobs: policy?.extraIncludePatterns ?? [] });
                    if (next?.kind === 'copy_once' || next?.kind === 'create_relationship') {
                        props.onChange(policy ? { ...next, contentPolicy: policy } : next);
                    }
                    setOpen(false);
                }}
            />
        </ItemGroup>
        {policy ? <WorkspaceActivationContentPolicyFields
            contentSelection={policy.selection}
            onContentSelectionChange={selection => updatePolicy({ selection })}
            includeIgnoredMode={includeIgnoredMode}
            onIncludeIgnoredModeChange={mode => {
                setIncludeIgnoredMode(mode);
                updatePolicy({ extraIncludePatterns: mode === 'include_selected' ? parseSessionHandoffIgnoredIncludeGlobs(patternsDraft) : [] });
            }}
            patternsDraft={patternsDraft}
            onPatternsDraftChange={value => {
                setPatternsDraft(value);
                updatePolicy({ extraIncludePatterns: parseSessionHandoffIgnoredIncludeGlobs(value) });
            }}
            disabled={props.disabled}
            testIdPrefix={props.testIdPrefix}
        /> : null}
    </>;
}
