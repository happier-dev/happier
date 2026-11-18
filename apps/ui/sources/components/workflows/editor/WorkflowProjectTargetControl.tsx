import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowWorkspaceSelection } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { SessionPlacementChips, useSessionPlacementPopovers, type SessionPlacementChipsHandle, type SessionPlacementChipTrigger, type SessionPlacementChoiceProps } from '@/components/sessions/new/placement/SessionPlacementChips';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { useCheckoutSelectionPicker } from '@/components/sessions/new/hooks/screenModel/useCheckoutSelectionPicker';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import { resolveNewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import { WORKSPACE_NEW_WORKTREE_OPTION_ID, type WorktreeSelectionStepScope } from '@/components/sessions/new/hooks/screenModel/buildWorktreeSelectionListSteps';
import { SessionAuthoringFieldSelectTrigger } from '@/components/sessions/authoring/controls/SessionAuthoringFieldSelectTrigger';
import { Icon } from '@/components/ui/icons/Icon';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useServerScopedMachine } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    selectWorkflowProjectMachine,
    setWorkflowProjectDirectory,
    setWorkflowProjectSessionPlacement,
    isWorkflowProjectTarget,
    type WorkflowAuthoringTarget,
} from '@/sync/domains/workflows/workflowProjectTarget';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { hasUnresolvedRequesterDirectories, resolveDefaultDirectoryForMachine, resolveMachineHomeDirectory } from '@/utils/sessions/machineDefaultDirectory';
import { useMachineOwnIsolationStatus } from '@/hooks/machine/useMachineOwnIsolationStatus';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { useStableRecentPathsResolver } from '@/utils/sessions/useStableRecentPathsForMachine';

import { workflowEditorStyles } from './workflowEditorStyles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowEditorAccountMemory } from '../screens/useWorkflowEditorAccountMemory';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

/**
 * Where a workflow runs: one exact Machine, its project folder and the checkout
 * of that folder's repository.
 *
 * Every choice here is the one New Session already offers. The Machine comes
 * from New Session's Machine chip and picker, a Machine's starting folder from the
 * shared default-directory policy, the folder from the canonical Machine path
 * browser, and the checkout from the one checkout picker New Session's chip
 * presents — so a workflow and a Session opened side by side agree about
 * "where". What stays Workflow-specific is only the value shape: the thin
 * `workflowProjectTarget` adapter keeps `workspaceRefId` truthful whenever the
 * folder moves. A new worktree is not a project choice here; it is authored as
 * the workflow's Workspace policy, which is why this picker offers no creation.
 */

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexWrap: 'wrap',
    },
    value: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    unresolved: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.placeholder,
        flexShrink: 1,
    },
    fixed: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    fixedValue: {
        color: theme.colors.text.primary,
    },
    fixedUnresolved: {
        color: theme.colors.text.placeholder,
    },
    fixedPath: {
        ...Typography.mono(),
    },
    path: {
        ...Typography.mono(),
    },
    control: {
        minWidth: 0,
        flexShrink: 1,
        paddingHorizontal: theme.space.s8,
        borderRadius: theme.borderRadius.md,
    },
}));

const EMPTY_WORKSPACE_REFS: ReadonlyArray<WorkspaceRefV1> = [];

/**
 * The one "where it runs" summary: "{machine} · {folder}". The header chip, the
 * Workflow settings field, the start composers' Where chip and the phone value
 * row all show this string, so a compacted surface truncates it and never
 * rephrases it. The separator is the app's Machine · folder one, never a slash:
 * a folder is itself a path, so "Mac / /" would read as one broken path. `null`
 * means no Machine is chosen yet.
 */
export function formatWorkflowWhereSummary(params: Readonly<{
    target: WorkflowAuthoringTarget | null | undefined;
    machineName: string | null;
    machineHomeDir?: string | null;
}>): string | null {
    const { target } = params;
    if (target === null || target === undefined || params.machineName === null) return null;
    if (!isWorkflowProjectTarget(target) || target.directory.trim().length === 0) return params.machineName;
    return `${params.machineName} · ${formatPathRelativeToHome(target.directory, params.machineHomeDir, {
        homeLabel: t('workspacePresentation.homeFolder'),
    })}`;
}

export type WorkflowWhereRowRenderer = (row: 'machine' | 'folder' | 'workspace', label: string, control: React.ReactNode) => React.ReactNode;
export type WorkflowWhereWorkspace = Readonly<{
    value: WorkflowWorkspaceSelection | undefined;
    onChange?: (next: WorkflowWorkspaceSelection) => void;
    /** A step's Workspace: its own rows lead the popover, and it never moves the workflow's folder. */
    step?: WorkflowStepWorkspaceScope;
}>;

/**
 * A step's choices beyond the workflow's ("Same as the workflow", "Where a step left it"), and the step's
 * current choice as the popover's selected row and the field's words.
 */
export type WorkflowStepWorkspaceScope = WorktreeSelectionStepScope & Readonly<{
    selection: Readonly<{ optionId: string; label: string }> | undefined;
}>;

/** What the Workspace field says, in the checkout picker's own words. */
function workflowWorkspaceFieldLabel(value: WorkflowWorkspaceSelection | undefined): string {
    return value?.kind === 'new_worktree' ? t('newSession.checkout.newWorktree') : t('newSession.checkout.noWorktree');
}

/** Opens the Where owner's picker from elsewhere (Run now with no Machine chosen). */
export type WorkflowProjectTargetControlHandle = Readonly<{ openPicker: () => void }>;

type WorkflowProjectTargetControlProps = Readonly<{
    currentUiContextCommandScope?: string;
    accountLifetime?: ServerAccountScopeLifetime | null;
    purpose?: 'workflow' | 'trigger' | 'background';
    target: WorkflowAuthoringTarget | null | undefined;
    /** The display name of the target Machine; `null` stays visibly unresolved. */
    machineName: string | null;
    /** Supplying both makes the target editable; a host that omits them shows it read-only. */
    machines?: readonly Machine[];
    /** Home directory for a frozen/read-only target whose machine inventory is not editable. */
    machineHomeDir?: string | null;
    /** Allows a folder choice on an already fixed Machine without Machine/account-memory discovery. */
    directoryEditable?: boolean;
    onChange?: (target: WorkflowAuthoringTarget) => void;
    /**
     * `chip`: the editor header's chip ("MacBook Pro · ~/src/happier", or the
     * quiet "Choose where it runs" while missing). `field`: one settings row —
     * its label, its description and one field select showing the same summary
     * (Workflow settings' "Machine and project", a trigger set's "Runs on").
     * Both open the one content-sized popover with the Machine, folder and
     * checkout choices. `inline` (the default): those choices in place, for a
     * host that is already that popover (a run composer's Where chip).
     * `value`: the value of a label/value row that already names it (How and
     * where it runs' "Machine and folder"): the bordered chips while editable,
     * otherwise what the field's read-only value says. `rows`: Machine, Folder
     * and Workspace each on a row the host draws on its own label track
     * (`renderRow`), each a bordered field select.
     */
    presentation?: 'chip' | 'field' | 'inline' | 'value' | 'rows' | 'sentence';
    /** `rows`: draws one labelled row of the host's track. */
    renderRow?: WorkflowWhereRowRenderer;
    /** `sentence`: the host draws the Machine and folder triggers (the workflow's sentence, round 1116c). */
    renderChip?: (chip: SessionPlacementChipTrigger) => React.ReactNode;
    /**
     * The workflow's Workspace (WF-REDESIGN-1116 change a): the checkout picker, New Session's, writes
     * this choice ("New worktree" per run, or the project folder) instead of only moving the folder.
     */
    workspace?: WorkflowWhereWorkspace;
    /** The field row's label; `field` only. */
    title?: string;
    /** The field row's description (its consequence), wrapping; `field` only. */
    subtitle?: string;
    /** Explicit field layout for a narrow desktop popover; defaults to the settings row's stack. */
    accessoryLayout?: ItemProps['accessoryLayout'];
    testIDPrefix: string;
}>;

/**
 * Where a workflow runs, as one owner with two presentations and one summary
 * string ({@link formatWorkflowWhereSummary}).
 */
export const WorkflowProjectTargetControl = React.forwardRef<
    WorkflowProjectTargetControlHandle,
    WorkflowProjectTargetControlProps
>(function WorkflowProjectTargetControl(props, ref): React.ReactElement {
    const { target, testIDPrefix } = props;
    const machine = target === undefined || target === null
        ? undefined
        : props.machines?.find((candidate) => candidate.id === target.machineId);
    const machineHomeDir = machine?.metadata?.homeDir ?? props.machineHomeDir ?? undefined;
    const editable = props.onChange !== undefined && (props.machines !== undefined || props.directoryEditable === true);
    // Machine and folder are New Session's two chips and pickers (owner 2026-11-12); the checkout follows.
    const chipsRef = React.useRef<SessionPlacementChipsHandle | null>(null);
    const editor = props.onChange !== undefined && (props.machines !== undefined || (props.directoryEditable === true && target)) ? (
        <WorkflowWhereChips
            handleRef={chipsRef}
            currentUiContextCommandScope={props.currentUiContextCommandScope}
            accountLifetime={props.accountLifetime}
            target={target ?? null}
            machines={props.machines}
            machineName={props.machineName}
            machineHomeDir={machineHomeDir ?? null}
            onChange={props.onChange}
            testIDPrefix={testIDPrefix}
            // One owner, two presentations by context (owner rulings 2026-11-13): chips in chip rows,
            // bordered where the editor header's other chips are; a labelled field row in forms.
            {...(props.presentation === 'rows' && props.renderRow !== undefined ? {
                presentation: 'fields' as const,
                renderRow: props.renderRow,
                ...(props.workspace === undefined ? {} : { workspace: props.workspace }),
            } : props.presentation === 'field' ? {
                presentation: 'fields' as const,
                title: props.title ?? t('workflows.page.sections.machineAndProject'),
                ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
                rowTestID: `${testIDPrefix}-machine-row`,
            } : props.presentation === 'sentence' && props.renderChip !== undefined ? { renderChip: props.renderChip }
                : props.presentation === 'chip' || props.presentation === 'value' ? { chipVariant: 'bordered' as const } : {})}
        />
    ) : null;
    const scope = props.currentUiContextCommandScope;
    const firstPicker = props.machines !== undefined ? 'machine' as const : 'folder' as const;
    const openPicker = React.useCallback(() => chipsRef.current?.open(firstPicker), [firstPicker]);
    useCurrentUiContextLocalCommands(scope === undefined || !editable ? [] : [
        { key: 'open', title: props.title ?? t('workflows.page.where.label'), description: `${scope}.open`, invoke: openPicker },
        { key: 'close', title: t('common.close'), description: `${scope}.close`, invoke: () => chipsRef.current?.close() },
    ], { foregroundOverlay: true, contextKey: scope });
    React.useImperativeHandle(ref, () => ({
        openPicker: () => { if (editable) openPicker(); },
    }), [editable, openPicker]);

    if (props.presentation === 'chip') {
        if (editor) return <View testID={`${testIDPrefix}-where-chips`} style={styles.row}>{editor}</View>;
        // Read-only: the place reads as one quiet chip that cannot be chosen.
        const summary = formatWorkflowWhereSummary({ target, machineName: props.machineName, machineHomeDir });
        return (
            <SelectionListFilterChip
                filter={{
                    id: 'workflow-where',
                    label: t('workflows.page.where.label'),
                    valueLabel: summary ?? t('workflows.page.where.choose'),
                    icon: <WhereChipIcon />,
                    muted: summary === null,
                    disabled: true,
                    testID: `${testIDPrefix}-where-chip`,
                }}
            />
        );
    }

    // What a person who can't edit reads: what is, never an ask to choose (FIN-DESIGN-REVIEW M7).
    const readOnlyValue = target === undefined || target === null || props.machineName === null ? (
        <Text testID={`${testIDPrefix}-machine`} style={styles.unresolved}>
            {props.machineName ?? (target === undefined || target === null
                ? t('workflows.editor.targetNotChosen') : t('workflows.editor.targetOtherMachine'))}
        </Text>
    ) : (
        <Text testID={`${testIDPrefix}-project-directory-readonly`} style={styles.value}>
            {formatWorkflowWhereSummary({ target, machineName: props.machineName, machineHomeDir })}
        </Text>
    );

    if (props.presentation === 'rows' && props.renderRow !== undefined) {
        if (editor) return editor;
        // Read-only: what is, on the same rows (FIN-DESIGN-REVIEW M7).
        const directory = target !== undefined && target !== null && isWorkflowProjectTarget(target)
            ? formatPathRelativeToHome(target.directory, machineHomeDir, { homeLabel: t('workspacePresentation.homeFolder') }) : null;
        return (
            <>
                {props.renderRow('machine', t('newSession.wizardSection.machine'), <Text testID={`${testIDPrefix}-machine`}
                    style={props.machineName === null ? styles.unresolved : styles.value}>
                    {props.machineName ?? (target === undefined || target === null ? t('workflows.editor.targetNotChosen') : t('workflows.editor.targetOtherMachine'))}
                </Text>)}
                {directory === null ? null : props.renderRow('folder', t('newSession.wizardSection.folder'),
                    <Text testID={`${testIDPrefix}-project-directory-readonly`} style={[styles.value, styles.path]}>{directory}</Text>)}
                {props.workspace === undefined ? null : props.renderRow('workspace', t('workflows.workspace.title'),
                    <Text testID={`${testIDPrefix}-workspace-readonly`} style={styles.value}>{workflowWorkspaceFieldLabel(props.workspace.value)}</Text>)}
            </>
        );
    }

    if (props.presentation === 'value') {
        return <View testID={`${testIDPrefix}-where-chips`} style={styles.row}>{editor ?? readOnlyValue}</View>;
    }
    if (props.presentation === 'sentence') {
        if (editor) return editor;
        // Read-only: the same triggers, which cannot be chosen.
        const directory = target !== undefined && target !== null && isWorkflowProjectTarget(target)
            ? formatPathRelativeToHome(target.directory, machineHomeDir, { homeLabel: t('workspacePresentation.homeFolder') }) : null;
        const noop = () => {};
        return <>
            {props.renderChip?.({ field: 'machine', title: t('newSession.wizardSection.machine'), value: props.machineName,
                placeholder: t('workflows.editor.targetNotChosen'), anchorRef: React.createRef<View>(), open: false, disabled: true, onPress: noop,
                testID: `${testIDPrefix}-machine` })}
            {props.renderChip?.({ field: 'folder', title: t('newSession.wizardSection.folder'), value: directory,
                placeholder: t('newSession.folder.noFolder'), anchorRef: React.createRef<View>(), open: false, disabled: true, onPress: noop,
                testID: `${testIDPrefix}-project-directory-readonly` })}
        </>;
    }

    if (props.presentation !== 'field') {
        return (
            <View testID={`${testIDPrefix}-machine-row`} style={styles.row}>
                {editable ? editor : (
                    // A fixed place is a fact of the start, said in one quiet line (lab flRun: the
                    // Session's Machine), not a field that looks like it could be chosen.
                    <Text style={styles.fixed} numberOfLines={2}>
                        {t('workflows.triggers.editor.runsOn')}{' '}
                        <Text testID={`${testIDPrefix}-machine`} style={props.machineName === null ? styles.fixedUnresolved : styles.fixedValue}>
                            {props.machineName ?? t('workflows.editor.targetRequired')}
                        </Text>
                        {target === undefined || target === null ? null : <>
                            {' \u00B7 '}
                            <Text testID={`${testIDPrefix}-project-directory-readonly`} style={isWorkflowProjectTarget(target) ? styles.fixedPath : undefined}>
                                {isWorkflowProjectTarget(target) ? formatPathRelativeToHome(target.directory, machineHomeDir, {
                                    homeLabel: t('workspacePresentation.homeFolder'),
                                }) : t('newSession.folder.noFolder')}
                            </Text>
                        </>}
                    </Text>
                )}
            </View>
        );
    }

    if (editor) return editor;
    return (
        <WhereField
            title={props.title ?? t('workflows.page.sections.machineAndProject')}
            accessoryLayout={props.accessoryLayout}
            {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
            readOnlyValue={readOnlyValue}
            testIDPrefix={testIDPrefix}
        />
    );
});

/** The field presentation for a host that fixes the place: its label and what is, never a choice. */
function WhereField(props: Readonly<{
    title: string;
    subtitle?: string;
    accessoryLayout?: ItemProps['accessoryLayout'];
    readOnlyValue: React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    return (
        <Item
            testID={`${props.testIDPrefix}-machine-row`}
            title={props.title}
            {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle, subtitleLines: 0 })}
            accessoryLayout={props.accessoryLayout ?? 'stacked'}
            showChevron={false}
            selected={false}
            mode="info"
            rightElement={props.readOnlyValue}
        />
    );
}

function WhereChipIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="desktop" size={14} color={theme.colors.text.secondary} />;
}

type WorkflowWhereInput = Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    target: WorkflowAuthoringTarget | null;
    /** The host's eligible Machines; absent: the Machine is fixed and only its folder is chosen. */
    machines?: readonly Machine[];
    machineName: string | null;
    machineHomeDir: string | null;
    /** Absent: the place is decided (an accepted Run) and only shown. */
    onChange?: (target: WorkflowAuthoringTarget) => void;
}>;

/**
 * The workflow rules New Session's Machine and folder pickers don't have: a Machine's starting folder
 * from the shared default-directory policy (a shared Machine's requester folder included), the Account's
 * recent folders, and `workspaceRefId` kept truthful whenever the folder moves. The chips here and the
 * run composers' Machine and folder chips both read their choices from this one owner.
 */
function useWorkflowWhereChoices(props: WorkflowWhereInput) {
    const { machines, onChange, target } = props;
    const accountLifetime = useWorkflowAccountLifetime(props.accountLifetime);
    const activeScope = useActiveServerAccountScope();
    const serverId = accountLifetime === undefined ? activeScope?.serverId ?? null : accountLifetime?.scope.serverId ?? null;
    const { recentMachinePaths, workspaceRefs: workspaceRefsSetting } = useWorkflowEditorAccountMemory(accountLifetime);
    const workspaceRefs = Array.isArray(workspaceRefsSetting) ? workspaceRefsSetting : EMPTY_WORKSPACE_REFS;
    const resolveRecentPathsForMachine = useStableRecentPathsResolver({
        recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
        // The Account's own recent-folder list is the canonical source here;
        // deriving paths from every Session would subscribe an open editor to
        // the whole Session list for a default it rarely needs.
        sessions: null,
    });

    const listed = target === null ? undefined : machines?.find((candidate) => candidate.id === target.machineId);
    const stored = useServerScopedMachine(serverId, listed || target === null ? null : target.machineId);
    const machine = listed ?? stored ?? undefined;
    const ownIsolation = useMachineOwnIsolationStatus({ machineId: machine?.id, machine, serverId,
        enabled: machine?.isShared === true || hasUnresolvedRequesterDirectories({ machine }) });
    const machineHomeDir = resolveMachineHomeDirectory({ machine, ownStatus: ownIsolation.status }) ?? props.machineHomeDir;
    const machinePlatform = machine?.metadata?.platform ?? null;
    const readOwnStatus = ownIsolation.readStatus;
    const selectMachine = React.useCallback(async (selected: Machine) => {
        if (!machines || !onChange) return;
        const needsRequesterStatus = selected.isShared === true || hasUnresolvedRequesterDirectories({ machine: selected });
        const ownStatus = needsRequesterStatus ? await readOwnStatus(selected.id) : null;
        if (needsRequesterStatus && ownStatus === null) return;
        onChange(selectWorkflowProjectMachine({
            current: target,
            machineId: selected.id,
            defaultDirectory: resolveDefaultDirectoryForMachine({
                machineId: selected.id,
                machines,
                recentPaths: resolveRecentPathsForMachine(selected.id),
                ownStatus,
            }),
            serverId,
            workspaceRefs,
        }));
    }, [machines, onChange, readOwnStatus, resolveRecentPathsForMachine, serverId, target, workspaceRefs]);
    const presetPlacement = target !== null && isWorkflowProjectTarget(target) && target.sessionPlacement?.kind === 'preset'
        ? target.sessionPlacement : null;
    const selectManagedMachine = React.useCallback((draft: ManagedMachineSelectionDraft) => {
        // Only a saved preset is a placement a workflow can keep; a one-off machine belongs to one Session.
        if (!onChange || target === null || draft.selection.kind !== 'preset') return;
        onChange(setWorkflowProjectSessionPlacement(target,
            { kind: 'preset', homeId: draft.selection.homeId, presetId: draft.selection.id }, serverId));
    }, [onChange, serverId, target]);
    const latest = React.useRef({ target, serverId, workspaceRefs, onChange });
    latest.current = { target, serverId, workspaceRefs, onChange };
    const moveToDirectory = React.useCallback((openedFor: WorkflowAuthoringTarget, directory: string) => {
        if (latest.current.target !== openedFor) return;
        latest.current.onChange?.(setWorkflowProjectDirectory({ current: openedFor, directory,
            serverId: latest.current.serverId, workspaceRefs: latest.current.workspaceRefs }));
    }, []);
    const selectPath = React.useCallback((directory: string) => {
        if (latest.current.target) moveToDirectory(latest.current.target, directory);
    }, [moveToDirectory]);
    const choice: SessionPlacementChoiceProps = {
        serverId: serverId ?? '',
        machine: machine ?? null,
        machineName: props.machineName,
        machineHomeDir,
        recentPaths: target === null ? EMPTY_RECENT_PATHS : resolveRecentPathsForMachine(target.machineId),
        path: target !== null && isWorkflowProjectTarget(target) ? target.directory : '',
        ...(machines && onChange ? { machines, onSelectMachine: (selected: Machine) => { void selectMachine(selected); },
            // New Session's preset offers and use callback (J6): a workflow saves the chosen preset as its placement.
            managedPlacementPreset: presetPlacement, onSelectManagedMachine: selectManagedMachine } : {}),
        onSelectPath: selectPath,
    };
    return { choice, serverId, machineHomeDir, machinePlatform, moveToDirectory, latest };
}

/** The Machine and folder (New Session's), then the checkout picker, with the workflow rules. */
function WorkflowWhereChips(props: WorkflowWhereInput & Readonly<{
    handleRef: React.Ref<SessionPlacementChipsHandle>;
    currentUiContextCommandScope?: string;
    testIDPrefix: string;
    presentation?: 'chips' | 'fields';
    chipVariant?: 'composer' | 'bordered';
    title?: string;
    subtitle?: string;
    rowTestID?: string;
    renderRow?: WorkflowWhereRowRenderer;
    renderChip?: (chip: SessionPlacementChipTrigger) => React.ReactNode;
    workspace?: WorkflowWhereWorkspace;
}>): React.ReactElement {
    const { target } = props;
    const { choice, serverId, machineHomeDir, machinePlatform, moveToDirectory, latest } = useWorkflowWhereChoices(props);
    // An agent browses folders with the Machine path browser under `${scope}.browser`, as before the chips.
    const scope = props.currentUiContextCommandScope;
    const CommandBridge = useCurrentUiContextCommandBridge();
    const browseDirectory = React.useCallback((callerContext?: ActionExecutorContext) => {
        const openedFor = latest.current.target;
        if (openedFor === null) return;
        void (async () => {
            const directory = await openMachinePathBrowserModal({
                currentUiContextCommandScope: scope === undefined ? undefined : `${scope}.browser`,
                commandBridge: scope === undefined ? undefined : CommandBridge,
                callerContext,
                machineId: openedFor.machineId,
                serverId,
                initialPath: isWorkflowProjectTarget(openedFor) ? openedFor.directory : machineHomeDir ?? undefined,
                selectionMode: 'directory',
                title: t('workflows.workspace.projectCheckout'),
            });
            if (directory !== null) moveToDirectory(openedFor, directory);
        })();
    }, [CommandBridge, latest, machineHomeDir, moveToDirectory, scope, serverId]);
    useCurrentUiContextLocalCommands(scope === undefined || target === null ? [] : [
        { key: 'browse', title: t('workflows.workspace.projectCheckout'), description: `${scope}.browse`, invoke: (_input, context) => browseDirectory(context) },
    ], { foregroundOverlay: true, contextKey: scope });

    return (
        <SessionPlacementChips
            {...choice}
            handleRef={props.handleRef}
            testIDPrefix={props.testIDPrefix}
            {...(scope === undefined ? {} : { currentUiContextCommandScope: scope })}
            {...(props.presentation === undefined ? {} : { presentation: props.presentation })}
            {...(props.chipVariant === undefined ? {} : { chipVariant: props.chipVariant })}
            {...(props.title === undefined ? {} : { title: props.title })}
            {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
            {...(props.rowTestID === undefined ? {} : { rowTestID: props.rowTestID })}
            // A workflow's Sessions follow the Machine's row for workflows and automations (J6); no one-time override.
            isolationWorkKind="automationsWorkflows"
            {...(props.renderRow === undefined ? {} : { renderFieldRow: props.renderRow })}
            {...(props.renderChip === undefined ? {} : { renderChip: props.renderChip })}
            trailing={props.renderChip === undefined && target !== null && isWorkflowProjectTarget(target) ? (() => {
                const picker = <ProjectCheckoutPicker
                    currentUiContextCommandScope={scope}
                    target={target}
                    serverId={serverId}
                    machineHomeDir={machineHomeDir}
                    machinePlatform={machinePlatform}
                    onSelectDirectory={moveToDirectory}
                    {...(props.workspace === undefined ? {} : { workspace: props.workspace })}
                    testIDPrefix={props.testIDPrefix}
                />;
                return props.renderRow === undefined ? picker : props.renderRow('workspace', t('workflows.workspace.title'), picker);
            })() : null}
        />
    );
}

/**
 * A run composer's Machine or folder chip content: New Session's picker for that chip, with the
 * workflow rules (see `useWorkflowWhereChoices`). Mounted only while its chip's popover is open.
 */
export function WorkflowStartPlacementPicker(props: WorkflowWhereInput & Readonly<{
    picker: 'machine' | 'folder';
    args: AgentInputContentPopoverRenderArgs;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const { choice } = useWorkflowWhereChoices(props);
    const { machinePopover, pathPopover } = useSessionPlacementPopovers({ ...choice, testIDPrefix: props.testIDPrefix });
    const content = (props.picker === 'machine' ? machinePopover : pathPopover).renderContent;
    return <>{typeof content === 'function' ? content(props.args) : content}</>;
}

const EMPTY_RECENT_PATHS: readonly string[] = [];

/** The canonical checkout picker for the selected project folder, when it is a Git repository. */
function ProjectCheckoutPicker(props: Readonly<{
    currentUiContextCommandScope?: string;
    target: WorkflowProjectTargetV1;
    serverId: string | null;
    machineHomeDir: string | null;
    machinePlatform: string | null;
    onSelectDirectory: (openedFor: WorkflowProjectTargetV1, directory: string) => void;
    /** Present: the picker is the workflow's Workspace field and writes the choice (change a). */
    workspace?: WorkflowWhereWorkspace;
    /** Opened from another control (a step card's Workspace chip): mounted open, hung from it, no own trigger. */
    controlled?: Readonly<{ anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>; onClose: () => void }>;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const { onSelectDirectory, target } = props;
    const workspaceValue = props.workspace?.value;
    const onChangeWorkspace = props.workspace?.onChange;
    const stepScope = props.workspace?.step;
    const { theme } = useUnistyles();
    const [openState, setOpen] = React.useState(false);
    const open = props.controlled !== undefined || openState;
    const onControlledClose = props.controlled?.onClose;
    const applyClose = React.useCallback(() => {
        setOpen(false);
        onControlledClose?.();
    }, [onControlledClose]);
    const ownAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const anchorRef = props.controlled?.anchorRef ?? ownAnchorRef;
    const repoScmSnapshot = useNewSessionRepoScmSnapshot({
        serverId: props.serverId,
        machineId: target.machineId,
        path: target.directory,
        machineHomeDir: props.machineHomeDir,
        machinePlatform: props.machinePlatform,
    });
    const checkoutChipModel = React.useMemo(() => resolveNewSessionCheckoutChipModel({
        selectedPath: target.directory,
        machineHomeDir: props.machineHomeDir,
        machinePlatform: props.machinePlatform,
        checkoutCreationDraft: null,
        repoSnapshot: repoScmSnapshot,
    }), [props.machineHomeDir, props.machinePlatform, repoScmSnapshot, target.directory]);
    const selectCheckoutPath = React.useCallback((path: string | null) => {
        applyClose();
        // A step works in the workflow's folder; only the workflow's own Workspace moves it.
        if (stepScope === undefined && path !== null && path !== target.directory) onSelectDirectory(target, path);
        // An existing checkout is the folder itself: the workflow works in it as it is.
        onChangeWorkspace?.({ kind: 'project_checkout' });
    }, [applyClose, onChangeWorkspace, onSelectDirectory, stepScope, target]);
    const workflowScope = React.useMemo(() => onChangeWorkspace === undefined ? undefined : {
        newWorktree: { onSelect: () => { applyClose(); onChangeWorkspace({ kind: 'new_worktree', source: { kind: 'original' } }); } },
        ...(stepScope === undefined ? {} : { step: {
            sameAsWorkflow: { subtitle: stepScope.sameAsWorkflow.subtitle,
                onSelect: () => { applyClose(); stepScope.sameAsWorkflow.onSelect(); } },
            fromSteps: stepScope.fromSteps.map((fromStep) => ({ ...fromStep,
                onSelect: () => { applyClose(); fromStep.onSelect(); } })),
        } }),
    }, [applyClose, onChangeWorkspace, stepScope]);
    const workspaceKind = workspaceValue?.kind;
    const selection = React.useMemo(() => stepScope !== undefined ? stepScope.selection : workspaceKind === 'new_worktree'
        ? { optionId: WORKSPACE_NEW_WORKTREE_OPTION_ID, label: t('newSession.checkout.newWorktree') } : undefined, [stepScope, workspaceKind]);
    const picker = useCheckoutSelectionPicker({
        repoScmSnapshot,
        checkoutChipModel,
        serverId: props.serverId,
        selectedMachineId: target.machineId,
        selectedPath: target.directory,
        machineHomeDir: props.machineHomeDir,
        machinePlatform: props.machinePlatform,
        onSelectCheckoutPath: selectCheckoutPath,
        ...(workflowScope === undefined ? {} : { workflowScope }),
        ...(selection === undefined ? {} : { selection }),
    });
    const scope = props.currentUiContextCommandScope;
    const commands = useCurrentUiContextLocalCommands(scope === undefined || picker === null ? [] : [
        { key: 'open', title: t('newSession.checkout.selectTitle'), description: `${scope}.checkout.open`, invoke: () => setOpen(true) },
        { key: 'close', title: t('common.close'), description: `${scope}.checkout.close`, invoke: applyClose },
    ], { foregroundOverlay: true, contextKey: scope });
    const togglePicker = scope === undefined ? () => setOpen(current => !current) : () => { void commands.invoke(open ? 'close' : 'open'); };
    if (props.controlled !== undefined) {
        return picker === null ? null : <AgentInputSelectionListPopover
            open
            anchorRef={anchorRef}
            rootStep={picker.rootStep}
            selectedOptionId={picker.selectedOptionId}
            onSelect={() => {
                // Each option's own `onSelect` is the action source; this wrapper owns only the close path.
            }}
            onRequestClose={applyClose}
            maxHeightCap={480}
        />;
    }
    if (props.workspace !== undefined) {
        // The Workspace row keeps its place where the folder is no Git repository (or not read yet): it
        // says the workflow works in the folder, and offers nothing it could not honour.
        const label = picker?.selectedLabel ?? stepScope?.selection?.label ?? workflowWorkspaceFieldLabel(workspaceValue);
        return (
            <>
                <SessionAuthoringFieldSelectTrigger
                    anchorRef={anchorRef}
                    title={t('workflows.workspace.title')}
                    label={label}
                    span="column"
                    open={open}
                    disabled={picker === null || onChangeWorkspace === undefined}
                    onPress={togglePicker}
                    testID={`${props.testIDPrefix}-project-checkout`}
                />
                {picker === null ? null : <AgentInputSelectionListPopover
                    currentUiContextCommandScope={scope === undefined ? undefined : `${scope}.checkout.list`}
                    open={open}
                    anchorRef={anchorRef}
                    rootStep={picker.rootStep}
                    selectedOptionId={picker.selectedOptionId}
                    onSelect={() => {
                        // Each option's own `onSelect` is the action source; this wrapper owns only the close path.
                    }}
                    onRequestClose={(context?: ActionExecutorContext) => {
                        if (scope === undefined || context !== undefined) applyClose();
                        else void commands.invoke('close');
                    }}
                    maxHeightCap={480}
                />}
            </>
        );
    }
    if (picker === null) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <HappierPressable
                    testID={`${props.testIDPrefix}-project-checkout`}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('newSession.checkout.selectTitle')}: ${picker.selectedLabel}`}
                    expanded={open}
                    onPress={scope === undefined ? () => setOpen(current => !current) : () => { void commands.invoke(open ? 'close' : 'open'); }}
                    style={(state) => [
                        workflowEditorStyles.actionTarget,
                        styles.control,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <Text numberOfLines={1} style={styles.value}>{picker.selectedLabel}</Text>
                </HappierPressable>
            </View>
            <AgentInputSelectionListPopover
                currentUiContextCommandScope={scope === undefined ? undefined : `${scope}.checkout.list`}
                open={open}
                anchorRef={anchorRef}
                rootStep={picker.rootStep}
                selectedOptionId={picker.selectedOptionId}
                onSelect={() => {
                    // Each option's own `onSelect` is the action source; this
                    // wrapper owns only the close path.
                }}
                onRequestClose={(context?: ActionExecutorContext) => {
                    if (scope === undefined || context !== undefined) applyClose();
                    else void commands.invoke('close');
                }}
                maxHeightCap={480}
            />
        </>
    );
}

/**
 * A step's Workspace field (WF-REDESIGN-1116 change a): the same checkout picker as the workflow's
 * Workspace row, for the workflow's place, with the step's own rows leading. Mounted only while the
 * step's options are open.
 */
export function WorkflowStepWorkspaceField(props: Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    target: WorkflowAuthoringTarget | null | undefined;
    machines?: readonly Machine[];
    machineName: string | null;
    workspace: WorkflowWhereWorkspace & Readonly<{ step: WorkflowStepWorkspaceScope }>;
    currentUiContextCommandScope?: string;
    testIDPrefix: string;
}>): React.ReactElement {
    const target = props.target ?? null;
    const { serverId, machineHomeDir, machinePlatform, moveToDirectory } = useWorkflowWhereChoices({
        ...(props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime }),
        target,
        ...(props.machines === undefined ? {} : { machines: props.machines }),
        machineName: props.machineName,
        machineHomeDir: null,
    });
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    if (target === null || !isWorkflowProjectTarget(target)) {
        // No folder chosen yet: the field says the step's choice and waits for the workflow's place.
        return <SessionAuthoringFieldSelectTrigger anchorRef={anchorRef} title={t('workflows.workspace.title')}
            label={props.workspace.step.selection?.label ?? workflowWorkspaceFieldLabel(props.workspace.value)}
            span="column" open={false} disabled onPress={() => {}} testID={`${props.testIDPrefix}-project-checkout`} />;
    }
    return (
        <ProjectCheckoutPicker
            currentUiContextCommandScope={props.currentUiContextCommandScope}
            target={target}
            serverId={serverId}
            machineHomeDir={machineHomeDir}
            machinePlatform={machinePlatform}
            onSelectDirectory={moveToDirectory}
            workspace={props.workspace}
            testIDPrefix={props.testIDPrefix}
        />
    );
}

/**
 * The same step-scope checkout picker opened from a step card's Workspace chip (WF-ACCEPT-1118 item 2): mounted
 * only while open, hung from the chip, closing on a choice or a dismissal. A workflow with no folder yet has
 * no checkout to offer; the chip opens the step's options instead.
 */
export function WorkflowStepWorkspacePicker(props: Readonly<{
    place: WorkflowStepPlace;
    workspace: WorkflowWhereWorkspace & Readonly<{ step: WorkflowStepWorkspaceScope }>;
    anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>;
    onClose: () => void;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const target = props.place.target ?? null;
    const { serverId, machineHomeDir, machinePlatform, moveToDirectory } = useWorkflowWhereChoices({
        ...(props.place.accountLifetime === undefined ? {} : { accountLifetime: props.place.accountLifetime }),
        target,
        ...(props.place.machines === undefined ? {} : { machines: props.place.machines }),
        machineName: props.place.machineName,
        machineHomeDir: null,
    });
    const controlled = React.useMemo(() => ({ anchorRef: props.anchorRef, onClose: props.onClose }), [props.anchorRef, props.onClose]);
    if (target === null || !isWorkflowProjectTarget(target)) return null;
    return (
        <ProjectCheckoutPicker
            target={target}
            serverId={serverId}
            machineHomeDir={machineHomeDir}
            machinePlatform={machinePlatform}
            onSelectDirectory={moveToDirectory}
            workspace={props.workspace}
            controlled={controlled}
            testIDPrefix={props.testIDPrefix}
        />
    );
}

/** The workflow's place, as a step's Workspace reads it: provided once by the editor page. */
export type WorkflowStepPlace = Pick<React.ComponentProps<typeof WorkflowStepWorkspaceField>, 'target' | 'machineName' | 'machines' | 'accountLifetime'>;
export const WorkflowStepPlaceContext = React.createContext<WorkflowStepPlace | null>(null);
