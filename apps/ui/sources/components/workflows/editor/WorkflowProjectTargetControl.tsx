import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useCheckoutSelectionPicker } from '@/components/sessions/new/hooks/screenModel/useCheckoutSelectionPicker';
import { useNewSessionRepoScmSnapshot } from '@/components/sessions/new/hooks/screenModel/useNewSessionRepoScmSnapshot';
import { resolveNewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { MachinePathBrowserView } from '@/components/ui/pathBrowser/MachinePathBrowserModal';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useInlineLevelFocusReturn } from '@/keyboard/focusReturn';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerAccountScope, } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    selectWorkflowProjectMachine,
    setWorkflowProjectDirectory,
    isWorkflowProjectTarget,
    type WorkflowAuthoringTarget,
} from '@/sync/domains/workflows/workflowProjectTarget';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { resolveDefaultDirectoryForMachine } from '@/utils/sessions/machineDefaultDirectory';
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
 * from the canonical `MachineSelector`, a Machine's starting folder from the
 * shared default-directory policy, the folder from the canonical Machine path
 * browser, and the checkout from the one checkout picker New Session's chip
 * presents — so a workflow and a Session opened side by side agree about
 * "where". What stays Workflow-specific is only the value shape: the thin
 * `workflowProjectTarget` adapter keeps `workspaceRefId` truthful whenever the
 * folder moves. A new worktree is not a project choice here; it is authored as
 * the workflow's Workspace policy, which is why this picker offers no creation.
 */

const styles = StyleSheet.create((theme) => ({
    back: { alignItems: 'flex-start', paddingBottom: theme.space.s8 },
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
    popover: {
        minWidth: 320,
        gap: theme.space.s4,
        paddingVertical: theme.space.s4,
        paddingHorizontal: theme.space.s8,
    },
    machineList: { width: '100%', minWidth: 0 },
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
    return `${params.machineName} · ${formatPathRelativeToHome(target.directory, params.machineHomeDir ?? undefined)}`;
}

/** Opens the Where owner's picker from elsewhere (Run now with no Machine chosen). */
export type WorkflowProjectTargetControlHandle = Readonly<{ openPicker: () => void }>;

type WorkflowProjectTargetControlProps = Readonly<{
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
     */
    presentation?: 'chip' | 'field' | 'inline';
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
    const editor = props.onChange === undefined ? null : props.machines !== undefined ? <EditableProjectTarget
        inline={props.presentation !== 'chip' && props.presentation !== 'field'}
        accountLifetime={props.accountLifetime} purpose={props.purpose ?? 'workflow'}
        target={target ?? null} machines={props.machines} onChange={props.onChange} testIDPrefix={testIDPrefix}
    /> : props.directoryEditable && target ? <>
        <Text testID={`${testIDPrefix}-machine`} style={props.machineName === null ? styles.unresolved : styles.value}>
            {props.machineName ?? t('workflows.editor.targetRequired')}
        </Text>
        <ProjectDirectoryControl inline={props.presentation !== 'chip' && props.presentation !== 'field'}
            target={target} machineHomeDir={machineHomeDir ?? null} machinePlatform={null}
            serverId={props.accountLifetime?.scope.serverId ?? null} workspaceRefs={EMPTY_WORKSPACE_REFS}
            onChange={props.onChange} testIDPrefix={testIDPrefix} />
    </> : null;
    const [pickerOpen, setPickerOpen] = React.useState(false);
    React.useImperativeHandle(ref, () => ({
        openPicker: () => { if (editable) setPickerOpen(true); },
    }), [editable]);

    if (props.presentation === 'chip') {
        const summary = formatWorkflowWhereSummary({ target, machineName: props.machineName, machineHomeDir });
        return (
            <SelectionListFilterChip
                filter={{
                    id: 'workflow-where',
                    label: t('workflows.page.where.label'),
                    valueLabel: summary ?? t('workflows.page.where.choose'),
                    icon: <WhereChipIcon />,
                    muted: summary === null,
                    disabled: !editable,
                    open: pickerOpen,
                    onOpenChange: setPickerOpen,
                    renderPopoverContent: () => (
                        <View testID={`${testIDPrefix}-where-popover`} style={styles.popover}>
                            {editor}
                        </View>
                    ),
                    testID: `${testIDPrefix}-where-chip`,
                }}
            />
        );
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
                                {isWorkflowProjectTarget(target) ? formatPathRelativeToHome(target.directory, machineHomeDir) : t('newSession.folder.noFolder')}
                            </Text>
                        </>}
                    </Text>
                )}
            </View>
        );
    }

    const summary = formatWorkflowWhereSummary({ target, machineName: props.machineName, machineHomeDir });
    return (
        <WhereField
            title={props.title ?? t('workflows.page.sections.machineAndProject')}
            accessoryLayout={props.accessoryLayout}
            {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
            summary={summary}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            readOnlyValue={editable ? null : (
                target === undefined || target === null || props.machineName === null ? (
                    <Text testID={`${testIDPrefix}-machine`} style={styles.unresolved}>
                        {props.machineName ?? t('workflows.editor.targetRequired')}
                    </Text>
                ) : (
                    <Text testID={`${testIDPrefix}-project-directory-readonly`} style={styles.value}>{summary}</Text>
                )
            )}
            testIDPrefix={testIDPrefix}
        >
            {editor}
        </WhereField>
    );
});

/**
 * The field presentation: one row, one field select (the canonical page field box) whose value is
 * the one where-summary; pressing it opens the same choices the chip opens. A read-only host gets
 * the summary as plain value text.
 */
function WhereField(props: Readonly<{
    title: string;
    subtitle?: string;
    accessoryLayout?: ItemProps['accessoryLayout'];
    summary: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Non-null: the target is fixed by the host and reads as this value. */
    readOnlyValue: React.ReactNode | null;
    testIDPrefix: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const fieldColors = React.useMemo(() => resolveFieldBoxColors(theme), [theme]);
    const editable = props.readOnlyValue === null;
    return (
        <View ref={anchorRef} collapsable={false}>
            <Item
                testID={`${props.testIDPrefix}-machine-row`}
                title={props.title}
                {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle, subtitleLines: 0 })}
                accessoryLayout={props.accessoryLayout ?? 'stacked'}
                showChevron={false}
                selected={false}
                {...(editable ? {
                    onPress: () => props.onOpenChange(!props.open),
                    accessibilityExpanded: props.open,
                    rightElement: renderDropdownItemTriggerRightElement({
                        detail: props.summary,
                        open: props.open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        field: fieldColors,
                        fieldSpan: props.accessoryLayout === 'inline' ? undefined : 'row',
                        placeholder: t('common.choose'),
                        placeholderColor: theme.colors.input.placeholder,
                    }),
                } : { mode: 'info' as const, rightElement: props.readOnlyValue })}
            />
            {editable && props.open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    focusReturnRef={anchorRef}
                    placement="auto"
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
                    maxWidthCap={420}
                    maxHeightCap={560}
                    onRequestClose={() => props.onOpenChange(false)}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} scrollEnabled surfaceChrome="theme">
                            <View testID={`${props.testIDPrefix}-where-popover`} style={styles.popover}>
                                {props.children}
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
}

function WhereChipIcon(): React.ReactElement {
    const { theme } = useUnistyles();
    return <Icon name="desktop" size={14} color={theme.colors.text.secondary} />;
}

function EditableProjectTarget(props: Readonly<{
    inline?: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
    purpose: 'workflow' | 'trigger' | 'background';
    target: WorkflowAuthoringTarget | null;
    machines: readonly Machine[];
    onChange: (target: WorkflowAuthoringTarget) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { machines, onChange, target, testIDPrefix } = props;
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

    const machine = target === null ? undefined : machines.find((candidate) => candidate.id === target.machineId);
    const machineHomeDir = machine?.metadata?.homeDir ?? null;
    const machinePlatform = machine?.metadata?.platform ?? null;
    const selectMachine = React.useCallback((selected: Machine) => {
        onChange(selectWorkflowProjectMachine({
            current: target,
            machineId: selected.id,
            defaultDirectory: resolveDefaultDirectoryForMachine({
                machineId: selected.id,
                machines,
                recentPaths: resolveRecentPathsForMachine(selected.id),
            }),
            serverId,
            workspaceRefs,
        }));
    }, [machines, onChange, resolveRecentPathsForMachine, serverId, target, workspaceRefs]);

    return <ProjectDirectoryControl inline={props.inline} target={target} serverId={serverId}
        workspaceRefs={workspaceRefs} machineHomeDir={machineHomeDir} machinePlatform={machinePlatform}
        onChange={onChange} testIDPrefix={testIDPrefix} checkout
        machineControl={<MachineSelector purpose={props.purpose} serverId={serverId} machines={machines}
            selectedMachine={machine ?? null} onSelect={selectMachine} presentation="list"
            showFavorites={false} showRecent={false} showCliGlyphs={false} testIdPrefix={`${testIDPrefix}-machine`} />} />;
}

/** The same folder browser serves editable placement and a host's fixed Machine. */
function ProjectDirectoryControl(props: Readonly<{
    inline?: boolean;
    target: WorkflowAuthoringTarget | null;
    serverId: string | null;
    workspaceRefs: readonly WorkspaceRefV1[];
    machineHomeDir: string | null;
    machinePlatform: string | null;
    onChange: (target: WorkflowAuthoringTarget) => void;
    testIDPrefix: string;
    checkout?: boolean;
    machineControl?: React.ReactNode;
}>) {
    const { target, serverId, machineHomeDir, machinePlatform, testIDPrefix } = props;
    const { theme } = useUnistyles();
    const [browsing, setBrowsing] = React.useState<WorkflowAuthoringTarget | null>(null);
    // Back (or a choice) returns focus to the folder control the inline browser replaced.
    const directoryFocus = useInlineLevelFocusReturn(browsing !== null);
    const targetRef = React.useRef(target);
    targetRef.current = target;
    const latest = React.useRef(props);
    latest.current = props;
    const moveToDirectory = React.useCallback((openedFor: WorkflowAuthoringTarget, directory: string) => {
        if (targetRef.current !== openedFor) return;
        latest.current.onChange(setWorkflowProjectDirectory({ current: openedFor, directory,
            serverId: latest.current.serverId, workspaceRefs: latest.current.workspaceRefs }));
    }, []);

    const browseDirectory = React.useCallback(() => {
        if (target === null) return;
        if (props.inline) { setBrowsing(target); return; }
        const openedFor = target;
        void (async () => {
            const directory = await openMachinePathBrowserModal({
                machineId: openedFor.machineId,
                serverId,
                initialPath: isWorkflowProjectTarget(openedFor) ? openedFor.directory : machineHomeDir ?? undefined,
                selectionMode: 'directory',
                title: t('workflows.workspace.projectCheckout'),
            });
            if (directory !== null) moveToDirectory(openedFor, directory);
        })();
    }, [machineHomeDir, moveToDirectory, target, serverId, props.inline]);

    const directoryLabel = target === null ? null : isWorkflowProjectTarget(target)
        ? formatPathRelativeToHome(target.directory, machineHomeDir ?? undefined)
        : t('newSession.folder.noFolder');

    if (browsing) return <View>
        {/* The same inline Back as the recipe body and participant picker (one look for a pushed level). */}
        <View style={styles.back}>
            <TextLinkButton testID="workflow-target-directory-back" label={t('common.back')} onPress={() => setBrowsing(null)}
                controlRef={directoryFocus.attachEntry} />
        </View>
        <MachinePathBrowserView machineId={browsing.machineId} serverId={serverId}
            initialPath={isWorkflowProjectTarget(browsing) ? browsing.directory : machineHomeDir}
            selectionMode="directory" variant="popover" interaction="immediate"
            onRequestClose={() => setBrowsing(null)}
            onPickPath={directory => { moveToDirectory(browsing, directory); setBrowsing(null); }} />
    </View>;

    return (
        <>
            {/* The Machine list is a whole choice: it takes its own line, and the folder follows beneath it. */}
            {props.machineControl ? <View style={styles.machineList}>{props.machineControl}</View> : null}
            {target === null || directoryLabel === null ? null : (
                <>
                    <HappierPressable
                        testID={`${testIDPrefix}-project-directory`}
                        controlRef={directoryFocus.attachOrigin}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('workflows.workspace.projectCheckout')}: ${directoryLabel}`}
                        onPress={browseDirectory}
                        style={(state) => [
                            workflowEditorStyles.actionTarget,
                            styles.control,
                            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        ]}
                    >
                        <Text numberOfLines={1} style={styles.value}>{directoryLabel}</Text>
                    </HappierPressable>
                    {props.checkout && isWorkflowProjectTarget(target) ? <ProjectCheckoutPicker
                        target={target}
                        serverId={serverId}
                        machineHomeDir={machineHomeDir}
                        machinePlatform={machinePlatform}
                        onSelectDirectory={moveToDirectory}
                        testIDPrefix={testIDPrefix}
                    /> : null}
                </>
            )}
        </>
    );
}

/** The canonical checkout picker for the selected project folder, when it is a Git repository. */
function ProjectCheckoutPicker(props: Readonly<{
    target: WorkflowProjectTargetV1;
    serverId: string | null;
    machineHomeDir: string | null;
    machinePlatform: string | null;
    onSelectDirectory: (openedFor: WorkflowProjectTargetV1, directory: string) => void;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const { onSelectDirectory, target } = props;
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
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
        setOpen(false);
        if (path !== null) onSelectDirectory(target, path);
    }, [onSelectDirectory, target]);
    const picker = useCheckoutSelectionPicker({
        repoScmSnapshot,
        checkoutChipModel,
        serverId: props.serverId,
        selectedMachineId: target.machineId,
        selectedPath: target.directory,
        machineHomeDir: props.machineHomeDir,
        machinePlatform: props.machinePlatform,
        onSelectCheckoutPath: selectCheckoutPath,
    });
    if (picker === null) return null;

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <HappierPressable
                    testID={`${props.testIDPrefix}-project-checkout`}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('newSession.checkout.selectTitle')}: ${picker.selectedLabel}`}
                    expanded={open}
                    onPress={() => setOpen((current) => !current)}
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
                open={open}
                anchorRef={anchorRef}
                rootStep={picker.rootStep}
                selectedOptionId={picker.selectedOptionId}
                onSelect={() => {
                    // Each option's own `onSelect` is the action source; this
                    // wrapper owns only the close path.
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={480}
            />
        </>
    );
}
