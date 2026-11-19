import * as React from 'react';
import { View } from 'react-native';
import { computeWorkspaceSyncPolicyDigest, type HandoffWorkspaceActionV1, type WorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { MachineSelector, type MachineSelectorProps } from '@/components/sessions/new/components/MachineSelector';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PathSelectionList, type PathSelectionListProps } from '@/components/ui/pathPicker/PathSelectionList';
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
    /** A line about the chosen machine (why the destination refused it), right under the machine row. */
    machineNotice?: React.ReactNode;
}>) {
    return (
        <View pointerEvents={props.disabled ? 'none' : 'auto'} importantForAccessibility={props.disabled ? 'no-hide-descendants' : 'auto'}>
            <MachineSelector {...props.machine} />
            {props.machineNotice}
            {/* What the destination still needs is the group's own note, on its text edge (the submit control
                carries the same reason as its hint). */}
            <ItemGroup title={props.pathTitle} description={props.blockedReason ?? undefined} clipContent>
                {props.fixedFolderLabel
                    ? <Item testID="workspace-activation-fixed-folder" title={props.fixedFolderLabel} showChevron={false} />
                    : <PathSelectionList {...props.path} />}
            </ItemGroup>
        </View>
    );
}

export function WorkspaceActivationModeField(props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedId: string;
    title: string;
    subtitle: string;
    items: ReadonlyArray<{ id: string; title: string; subtitle: string; disabled?: boolean }>;
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
            // A field select sits beside its label while there is room and moves beneath it on a phone.
            itemProps: { accessoryLayout: 'adaptive', disabled: props.disabled, ...(props.testID ? { testID: props.testID } : {}) },
        }}
        items={props.items}
        onSelect={(id) => { if (!props.disabled) props.onSelect(id); }}
    />;
}

type WorkspaceActivationContentPolicyProps = Readonly<{
    contentSelection: 'git_worktree' | 'all_files';
    onContentSelectionChange: (value: 'git_worktree' | 'all_files') => void;
    includeIgnoredMode: 'exclude' | 'include_selected';
    onIncludeIgnoredModeChange: (value: 'exclude' | 'include_selected') => void;
    patternsDraft: string;
    onPatternsDraftChange: (value: string) => void;
    /** A host that saves on its own takes the typed patterns once, when the field is left. */
    onPatternsEndEditing?: () => void;
    disabled?: boolean;
    testIdPrefix?: string;
}>;

/** Raw comma-separated patterns remain a draft until the host submits its action. */
export function WorkspaceActivationContentPolicyFields(props: WorkspaceActivationContentPolicyProps) {
    return <ItemGroup><WorkspaceActivationContentPolicyRows {...props} /></ItemGroup>;
}

/** The content-policy rows alone, for a host that places them inside a sheet it already owns. */
export function WorkspaceActivationContentPolicyRows(props: WorkspaceActivationContentPolicyProps) {
    const [openMenu, setOpenMenu] = React.useState<'content' | 'ignored' | null>(null);
    const selectedContent = SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS.find((option) => option.id === props.contentSelection)!;
    // Preference rows carry no icon (anatomy: only navigation rows and identity marks do).
    return <>
        <WorkspaceActivationModeField
            open={openMenu === 'content'} onOpenChange={(open) => setOpenMenu(open ? 'content' : null)}
            selectedId={props.contentSelection}
            title={t('settingsSession.handoff.contentSelection.title')}
            subtitle={t(selectedContent.subtitleKey)}
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
            testID={props.testIdPrefix ? `${props.testIdPrefix}-ignored-mode-trigger` : undefined}
            disabled={props.disabled}
            items={SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.map((option) => ({ id: option.id, title: t(option.titleKey), subtitle: t(option.subtitleKey) }))}
            onSelect={(id) => { props.onIncludeIgnoredModeChange(id as 'exclude' | 'include_selected'); setOpenMenu(null); }}
        />
        {props.includeIgnoredMode === 'include_selected' ? <WorkspaceSyncIgnoredIncludePatternsField
            value={props.patternsDraft}
            onChangeText={props.onPatternsDraftChange}
            onEndEditing={props.onPatternsEndEditing}
            editable={!props.disabled}
        /> : null}
    </>;
}

/**
 * The rows' draft for a host that owns one content policy: the ignored-files mode and the typed patterns stay
 * local until they make a policy, which `onChange` receives with its digest. A host that saves on its own
 * (`commitPatterns: 'endEditing'`) takes the patterns when the field is left, not on every keystroke.
 */
export function useWorkspaceContentPolicyRows(input: Readonly<{
    policy: WorkspaceContentPolicyV1 | null;
    onChange: (policy: WorkspaceContentPolicyV1) => void;
    commitPatterns?: 'change' | 'endEditing';
    disabled?: boolean;
    testIdPrefix?: string;
}>): WorkspaceActivationContentPolicyProps | null {
    const policy = input.policy;
    const hasIncludes = Boolean(policy?.extraIncludePatterns.length);
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
    if (!policy) return null;
    const updatePolicy = (patch: Partial<Omit<WorkspaceContentPolicyV1, 'policyDigest'>>) => {
        const { policyDigest: _digest, ...current } = policy;
        const next = { ...current, ...patch };
        input.onChange({ ...next, policyDigest: computeWorkspaceSyncPolicyDigest(next) });
    };
    const commitOnEnd = input.commitPatterns === 'endEditing';
    return {
        contentSelection: policy.selection,
        onContentSelectionChange: selection => updatePolicy({ selection }),
        includeIgnoredMode,
        onIncludeIgnoredModeChange: mode => {
            setIncludeIgnoredMode(mode);
            updatePolicy({ extraIncludePatterns: mode === 'include_selected' ? parseSessionHandoffIgnoredIncludeGlobs(patternsDraft) : [] });
        },
        patternsDraft,
        onPatternsDraftChange: value => {
            setPatternsDraft(value);
            if (!commitOnEnd) updatePolicy({ extraIncludePatterns: parseSessionHandoffIgnoredIncludeGlobs(value) });
        },
        ...(commitOnEnd ? { onPatternsEndEditing: () => {
            const parsed = parseSessionHandoffIgnoredIncludeGlobs(patternsDraft);
            if (parsed.length !== policy.extraIncludePatterns.length || parsed.some((value, index) => value !== policy.extraIncludePatterns[index])) {
                updatePolicy({ extraIncludePatterns: parsed });
            }
        } } : {}),
        disabled: input.disabled,
        testIdPrefix: input.testIdPrefix,
    };
}

/**
 * Copy and relationship editing share the incumbent Sync action and content-policy fields. They are rows
 * inside the host's own sheet (Open's "A copy of another checkout" row discloses them in place): the sync
 * mode, then one Files row that keeps the content choices folded until the person asks for them.
 */
export function WorkspaceActivationSyncFields(props: Readonly<{
    action: HandoffWorkspaceActionV1;
    onChange: (action: HandoffWorkspaceActionV1) => void;
    disabled?: boolean;
    testIdPrefix?: string;
}>) {
    const action = props.action;
    const policy = action.kind === 'copy_once' || action.kind === 'create_relationship' ? action.contentPolicy : null;
    const [open, setOpen] = React.useState(false);
    const [filesExpanded, setFilesExpanded] = React.useState(false);
    const policyRows = useWorkspaceContentPolicyRows({ policy, disabled: props.disabled, testIdPrefix: props.testIdPrefix,
        onChange: contentPolicy => {
            if (action.kind === 'copy_once' || action.kind === 'create_relationship') props.onChange({ ...action, contentPolicy });
        } });
    const includeIgnoredMode = policyRows?.includeIgnoredMode ?? 'exclude';
    const selectedId = action.kind === 'create_relationship' ? action.mode : action.kind;
    const options = SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.filter(option => option.id !== 'none');
    const selected = options.find(option => option.id === selectedId);
    const contentTitle = policy ? SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS.find(option => option.id === policy.selection)?.titleKey : undefined;
    const ignoredTitle = SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.find(option => option.id === includeIgnoredMode)!.titleKey;
    return <>
        <WorkspaceActivationModeField
            open={open} onOpenChange={setOpen}
            selectedId={selectedId}
            title={t('sessionHandoff.targetApproval.modeLabel')}
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
        {policy && policyRows ? <ExpandableItem
            // The last row of its host's sheet: no hairline after it (the sheet's edge closes it).
            showDivider={false}
            expanded={filesExpanded}
            onExpandedChange={setFilesExpanded}
            header={(state) => <Item {...state.headerProps}
                testID={props.testIdPrefix ? `${props.testIdPrefix}.files` : undefined}
                title={t('projects.open.copyFiles')}
                subtitle={[contentTitle ? t(contentTitle) : null, t(ignoredTitle)].filter(Boolean).join(' · ')}
                showChevron />}
        ><WorkspaceActivationContentPolicyRows {...policyRows} /></ExpandableItem> : null}
    </>;
}
