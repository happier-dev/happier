import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type { SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { PathSelectionList } from './components/PathSelectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useInlineLevelFocusReturn } from '@/keyboard/focusReturn';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { SESSION_FOLDER_SELECTION_ROOT_ID, resolveSessionFolderSelectionLabel } from '@/components/sessions/organization/sessionFolderSelectionOptions';
import type { SessionServerStartDraftSeed } from './serverStartDraftComposer';
import type { SessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';
import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** The recipe fields this composer edits through the Session-owned authoring controls, in reading order. */
const AGENT_FIELDS: readonly SessionAuthoringFieldId[] = [
    'agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides', 'permissionMode', 'profileId',
];
const TOOL_FIELDS: readonly SessionAuthoringFieldId[] = [
    'capabilitySelection', 'connectedServices', 'unlistedTools', 'allowedTools',
];

/** What an added agent shows as composer chips (lab dpRev `add`): engine, Runs through, permissions. */
const CHIP_FIELDS: readonly SessionAuthoringFieldId[] = ['agentTarget', 'connectedServices', 'permissionMode'];
const NO_MACHINES: readonly Machine[] = [];

/**
 * The same Session-owned fields inside an inline editor or its returning sheet. `chips` shows them as
 * a new Session's composer does: the shared authoring chips, then the one Where chip (Machine · folder);
 * choosing another Machine there hands the move to `onMoveMachine`, since the recipe belongs to a Machine.
 */
export function SessionServerStartDraftComposerBody(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    model: SessionServerStartDraftRecipe;
    presentation?: 'fields' | 'chips';
    onMoveMachine?: (machineId: string, directory: string) => void;
}>) {
    if (props.presentation === 'chips') return <ComposerChips model={props.model} onMoveMachine={props.onMoveMachine} />;
    return <ComposerFields seed={props.seed} model={props.model} />;
}

function ComposerChips(props: Readonly<{
    model: SessionServerStartDraftRecipe;
    onMoveMachine?: (machineId: string, directory: string) => void;
}>) {
    const { selectedTarget, selectedPlacement, machine, directory, setDirectory, setDirectoryEdited, setError, error, facts,
        agentTargets, selection, changeFields, changeField, daemonMergedProjection } = props.model;
    const machines = useMachineListForServer(selectedTarget.serverId) ?? NO_MACHINES;
    const agentsReady = daemonMergedProjection.phase === 'ready' && agentTargets.length > 0;
    const where = React.useMemo(() => ({ machineId: selectedTarget.machineId, directory: directory.trim() }),
        [directory, selectedTarget.machineId]);
    const { onMoveMachine } = props;
    const changeWhere = React.useCallback((next: Parameters<NonNullable<React.ComponentProps<typeof WorkflowProjectTargetControl>['onChange']>>[0]) => {
        const nextDirectory = isWorkflowProjectTarget(next) ? next.directory : '';
        if (next.machineId !== selectedTarget.machineId) {
            onMoveMachine?.(next.machineId, nextDirectory);
            return;
        }
        setError(false);
        setDirectory(nextDirectory);
        setDirectoryEdited(true);
    }, [onMoveMachine, selectedTarget.machineId, setDirectory, setDirectoryEdited, setError]);
    return (
        <View testID="server-start-draft-chips" style={styles.chips}>
            {agentsReady ? (
                <SessionAuthoringControls
                    presentation="chips"
                    fields={CHIP_FIELDS}
                    values={selection}
                    facts={facts}
                    onChangeFields={changeFields}
                    onChangeField={changeField}
                    testIDPrefix="server-start-draft-control"
                />
            ) : daemonMergedProjection.phase === 'idle' || daemonMergedProjection.phase === 'loading'
                || (daemonMergedProjection.phase === 'ready' && facts.agentTargets === undefined) ? (
                <ItemLoadStateRows state={{ kind: 'loading' }} rows={1} lines={1} accessibilityLabel={t('common.loading')} />
            ) : (
                <Text style={styles.note}>{daemonMergedProjection.phase === 'unsupported'
                    ? t('newSession.actionMethodUnavailable') : t('errors.daemonUnavailableBody')}</Text>
            )}
            <WorkflowProjectTargetControl
                presentation="chip"
                target={where}
                machineName={machine ? getMachineDisplayName(machine) : null}
                machineHomeDir={machine?.metadata?.homeDir ?? null}
                machines={onMoveMachine ? machines : undefined}
                directoryEditable
                onChange={changeWhere}
                testIDPrefix="participant-recipe"
            />
            {selectedPlacement.machineReady ? null : (
                <Text testID="server-start-draft-machine-not-ready" style={styles.note}>{t('newSession.recipeComposerMachineNotReady')}</Text>
            )}
            {error ? (
                <Text accessibilityLiveRegion="polite" style={styles.chipError}>
                    {t('newSession.failedToStart')}
                </Text>
            ) : null}
        </View>
    );
}

function ComposerFields(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    model: SessionServerStartDraftRecipe;
}>) {
    const { selectedTarget, selectedPlacement, machine, directory, noFolderSelected, setDirectory, setDirectoryEdited,
        directoryCandidateIndex, setSelectedCandidateIndex, error, setError, facts, agentTargets,
        selection, changeFields, changeField, organization, folderMenuOpen, setFolderMenuOpen, folderOptions,
        retainedFolderId, folderResolved, folderChoosable, showFolder, daemonMergedProjection,
        placementRows } = props.model;
    const agentsReady = daemonMergedProjection.phase === 'ready' && agentTargets.length > 0;
    // A folder is a deeper choice: it pushes the browser inside this body with Back (lab flows `browseP`),
    // so the recipe reads as a few rows instead of a search list.
    const [browsing, setBrowsing] = React.useState(false);
    // Back (or a choice) returns focus to the Working directory row the browser replaced.
    const directoryFocus = useInlineLevelFocusReturn(browsing);
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const homeDir = machine?.metadata?.homeDir ?? null;
    if (browsing) {
        return (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                <View style={styles.back}>
                    <TextLinkButton testID="server-start-draft-directory-back" label={t('common.back')} onPress={() => setBrowsing(false)}
                        controlRef={directoryFocus.attachEntry} />
                </View>
                <ItemGroup title={t('newSession.recipeComposerDirectory')}>
                    {placementRows.map(({ candidate, index, title, subtitle }) => (
                        <Item
                            key={'id' in candidate.projectKey
                                ? candidate.projectKey.id
                                : `${candidate.serverId}:${candidate.machineId}:${candidate.rootPath}`}
                            title={title}
                            {...(subtitle ? { subtitle, subtitleLines: 2 } : {})}
                            selected={index === directoryCandidateIndex}
                            onPress={() => {
                                setError(false);
                                setSelectedCandidateIndex(index);
                                setDirectory(candidate.rootPath);
                                setDirectoryEdited(true);
                                setBrowsing(false);
                            }}
                            showChevron={false}
                            showDivider={true}
                        />
                    ))}
                    <PathSelectionList
                        initialValue={directory}
                        machineHomeDir={homeDir ?? '/home'}
                        favorites={[]}
                        recents={[]}
                        machineId={machine?.id ?? null}
                        serverId={selectedTarget.serverId}
                        machinePlatform={machineMetadataPlatformToTarget(machine?.metadata?.platform)}
                        onCommit={(value) => {
                            setError(false);
                            setDirectory(value);
                            setDirectoryEdited(true);
                            setBrowsing(false);
                        }}
                        onChangeDraftPath={(value) => {
                            setError(false);
                            setDirectory(value);
                            setDirectoryEdited(true);
                        }}
                        onRequestClose={() => setBrowsing(false)}
                        maxHeight={300}
                    />
                </ItemGroup>
            </ScrollView>
        );
    }
    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {/* Who runs it first, then where (lab flows `sel`): the agent's fields lead the recipe. */}
            <ItemGroup>
                {agentsReady ? (
                    <SessionAuthoringControls
                        presentation="fields"
                        fields={AGENT_FIELDS}
                        values={selection}
                        facts={facts}
                        onChangeFields={changeFields}
                        onChangeField={changeField}
                        testIDPrefix="server-start-draft-control"
                    />
                ) : daemonMergedProjection.phase === 'idle' || daemonMergedProjection.phase === 'loading'
                    || (daemonMergedProjection.phase === 'ready' && facts.agentTargets === undefined) ? (
                    <ItemLoadStateRows state={{ kind: 'loading' }} rows={2} lines={1} accessibilityLabel={t('common.loading')} />
                ) : daemonMergedProjection.phase !== 'ready' ? (
                    // The machine answered that it cannot list its agents (`unsupported`), or it did not answer.
                    <ItemLoadStateRows state={{
                        kind: 'failed',
                        reason: daemonMergedProjection.phase === 'unsupported'
                            ? t('newSession.actionMethodUnavailable')
                            : t('errors.daemonUnavailableBody'),
                    }} />
                ) : (
                    <Item
                        title={t('newSession.failedToStart')}
                        mode="info"
                        showChevron={false}
                    />
                )}
            </ItemGroup>
            {/* Where the recipe runs and where its sessions are listed. A placement candidate may move it to another Machine. */}
            <ItemGroup>
                <Item
                    testID="server-start-draft-machine"
                    title={t('newSession.recipeComposerMachine')}
                    detail={machine ? getMachineDisplayName(machine) : t('common.unavailable')}
                    {...(selectedPlacement.machineReady ? {} : { subtitle: t('newSession.recipeComposerMachineNotReady'), subtitleLines: 0 })}
                    showChevron={false}
                />
                <Item
                    testID="server-start-draft-directory"
                    pressableRef={directoryFocus.attachOrigin}
                    title={t('newSession.recipeComposerDirectory')}
                    detail={noFolderSelected || !directory.trim() ? t('newSession.folder.noFolder') : formatPathRelativeToHome(directory, homeDir)}
                    onPress={() => setBrowsing(true)}
                />
                {showFolder && folderChoosable ? (
                    <DropdownMenu
                        testID="server-start-draft-folder"
                        open={folderMenuOpen}
                        onOpenChange={setFolderMenuOpen}
                        selectedId={organization.placement.folderId ?? SESSION_FOLDER_SELECTION_ROOT_ID}
                        itemTrigger={{
                            title: t('settingsSession.sessionPlacement.title'),
                            detailFormatter: () => resolveSessionFolderSelectionLabel(retainedFolderId, organization.folderTargets),
                            subtitleFormatter: () => folderResolved
                                ? t('settingsSession.sessionPlacement.description')
                                : t('newSession.recipeComposerFolderRetained'),
                            // The reason a Folder is kept reads in full, not cut beside its value.
                            itemProps: { subtitleLines: 0 },
                        }}
                        items={folderOptions.map((option) => ({ id: option.id, title: option.label }))}
                        onSelect={(id) => {
                            setFolderMenuOpen(false);
                            organization.setFolderId(folderOptions.find((option) => option.id === id)?.folderId ?? null);
                        }}
                    />
                ) : showFolder ? (
                    <Item
                        testID="server-start-draft-folder"
                        title={t('settingsSession.sessionPlacement.title')}
                        detail={resolveSessionFolderSelectionLabel(retainedFolderId, organization.folderTargets)}
                        subtitle={t('newSession.recipeComposerFolderRetained')}
                        subtitleLines={0}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {agentsReady ? (
                // Tools are rarely changed for a recipe: one closed disclosure, as in the lab's "Profile and tools".
                <ExpandableItem
                    testID="server-start-draft-tools"
                    expanded={toolsOpen}
                    onExpandedChange={setToolsOpen}
                    showDivider={false}
                    header={({ headerProps }) => (
                        <HappierPressable
                            testID="server-start-draft-tools-header"
                            onPress={headerProps.onPress}
                            accessibilityRole="button"
                            accessibilityLabel={t('settingsSession.toolPolicy.sectionTitle')}
                            expanded={toolsOpen}
                        >
                            <ItemGroup
                                title={t('settingsSession.toolPolicy.sectionTitle')}
                                description={t('settingsSession.toolPolicy.sectionDescription')}
                                action={<DisclosureCaret expanded={toolsOpen} size={14} />}
                                actionLayout="trailing"
                                surface="none"
                            >{null}</ItemGroup>
                        </HappierPressable>
                    )}
                >
                    <ItemGroup headerStyle={styles.toolsGroup}>
                        <SessionAuthoringControls
                            presentation="fields"
                            fields={TOOL_FIELDS}
                            values={selection}
                            facts={facts}
                            onChangeField={changeField}
                            testIDPrefix="server-start-draft-control"
                        />
                    </ItemGroup>
                </ExpandableItem>
            ) : null}
            {error ? (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                    {t('newSession.failedToStart')}
                </Text>
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: { paddingBottom: theme.space.s16 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s6, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    note: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    chipError: { ...Typography.variant('meta'), color: theme.colors.state.danger.foreground },
    back: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8, alignItems: 'flex-start' },
    toolsGroup: { paddingTop: 0 },
    error: { marginHorizontal: theme.space.s24, marginTop: theme.space.s12, color: theme.colors.state.danger.foreground },
}));
