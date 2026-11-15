import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type { SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SidePaneInspectorSections } from '@/components/ui/lists/SidePaneInspectorSections';
import { Text } from '@/components/ui/text/Text';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { SESSION_FOLDER_SELECTION_ROOT_ID, resolveSessionFolderSelectionLabel } from '@/components/sessions/organization/sessionFolderSelectionOptions';
import type { SessionServerStartDraftSeed } from './serverStartDraftComposer';
import type { SessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';
import { SessionPlacementChips } from './placement/SessionPlacementChips';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** The recipe fields this composer edits through the Session-owned authoring controls, in reading order. */
const AGENT_FIELDS: readonly SessionAuthoringFieldId[] = [
    'agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides', 'permissionMode', 'profileId', 'approvalProfileId',
];
const TOOL_FIELDS: readonly SessionAuthoringFieldId[] = [
    'capabilitySelection', 'connectedServices', 'unlistedTools', 'allowedTools',
];

/** What an added agent shows as composer chips (lab dpRev `add`): engine, Runs through, permissions. */
const CHIP_FIELDS: readonly SessionAuthoringFieldId[] = ['agentTarget', 'connectedServices', 'permissionMode', 'approvalProfileId'];

/**
 * The same Session-owned fields inside an inline editor or its returning sheet. `chips` shows them as
 * a new Session's composer does: the shared authoring chips, then New Session's Machine and folder chips;
 * choosing another Machine there hands the move to `onMoveMachine`, since the recipe belongs to a Machine.
 * `fields` keeps the same Machine and folder chips above its rows.
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

/** The recipe's folder through the shared folder chip: a typed or picked path, no folder, or a saved project. */
function useRecipeFolderChoice(model: SessionServerStartDraftRecipe) {
    const { setDirectory, setDirectoryEdited, setError, setSelectedCandidateIndex, placementRows } = model;
    const changeDirectory = React.useCallback((next: string) => {
        setError(false);
        setDirectory(next);
        setDirectoryEdited(true);
    }, [setDirectory, setDirectoryEdited, setError]);
    const clearDirectory = React.useCallback(() => changeDirectory(''), [changeDirectory]);
    const placementCandidates = React.useMemo(() => placementRows.length === 0 ? undefined : {
        rows: placementRows,
        onSelect: (candidate: (typeof placementRows)[number]['candidate']) => {
            const row = placementRows.find((entry) => entry.candidate === candidate);
            if (row) setSelectedCandidateIndex(row.index);
            changeDirectory(candidate.rootPath);
        },
    }, [changeDirectory, placementRows, setSelectedCandidateIndex]);
    return { changeDirectory, clearDirectory, placementCandidates };
}

function ComposerChips(props: Readonly<{
    model: SessionServerStartDraftRecipe;
    onMoveMachine?: (machineId: string, directory: string) => void;
}>) {
    const { selectedTarget, selectedPlacement, machine, directory, error, facts,
        agentTargets, selection, changeFields, changeField, daemonMergedProjection } = props.model;
    const agentsReady = daemonMergedProjection.phase === 'ready' && agentTargets.length > 0;
    const { onMoveMachine } = props;
    // Another Machine restarts the recipe there (it belongs to a Machine), keeping its folder.
    const moveMachine = React.useCallback((next: Machine) => {
        if (next.id !== selectedTarget.machineId) onMoveMachine?.(next.id, directory.trim());
    }, [directory, onMoveMachine, selectedTarget.machineId]);
    const { changeDirectory, clearDirectory, placementCandidates } = useRecipeFolderChoice(props.model);
    return (
        <View testID="server-start-draft-chips" style={styles.chips}>
            {agentsReady ? (
                // The authoring chips wrap inside this row's width instead of running past its edge (dpRev at 390).
                <View style={styles.authoringChips}>
                    <SessionAuthoringControls
                        presentation="chips"
                        fields={CHIP_FIELDS}
                        values={selection}
                        facts={facts}
                        onChangeFields={changeFields}
                        onChangeField={changeField}
                        testIDPrefix="server-start-draft-control"
                    />
                </View>
            ) : daemonMergedProjection.phase === 'idle' || daemonMergedProjection.phase === 'loading'
                || (daemonMergedProjection.phase === 'ready' && facts.agentTargets === undefined) ? (
                <ItemLoadStateRows state={{ kind: 'loading' }} rows={1} lines={1} accessibilityLabel={t('common.loading')} />
            ) : (
                <Text style={styles.note}>{daemonMergedProjection.phase === 'unsupported'
                    ? t('newSession.actionMethodUnavailable') : t('errors.daemonUnavailableBody')}</Text>
            )}
            {/* Machine and folder are New Session's two chips and pickers (owner 2026-11-12). */}
            <SessionPlacementChips
                serverId={selectedTarget.serverId}
                machine={machine}
                path={directory}
                {...(onMoveMachine ? { onSelectMachine: moveMachine } : {})}
                onSelectPath={changeDirectory}
                onSelectNoFolder={clearDirectory}
                {...(placementCandidates ? { placementCandidates } : {})}
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
    const { selectedTarget, selectedPlacement, machine, directory, facts, agentTargets, error,
        selection, changeFields, changeField, organization, folderMenuOpen, setFolderMenuOpen, folderOptions,
        retainedFolderId, folderResolved, folderChoosable, showFolder, daemonMergedProjection } = props.model;
    const agentsReady = daemonMergedProjection.phase === 'ready' && agentTargets.length > 0;
    const [toolsOpen, setToolsOpen] = React.useState(false);
    const { changeDirectory, clearDirectory, placementCandidates } = useRecipeFolderChoice(props.model);
    return (
        // A form wherever it is hosted (a sheet, the composer's To menu): the narrow host's page anatomy (flat
        // sections, one inset, bordered fields), never the menu's grouped look or cards inside a popover.
        <SidePaneInspectorSections>
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
            {/* Where the recipe runs: a form row of New Session's Machine and folder fields, as Agent and model
                is one (owner rulings 2026-11-13); a saved project may move the Machine. */}
            <ItemGroup>
                <SessionPlacementChips
                    presentation="fields"
                    title={t('workflows.page.sections.whereTitle')}
                    {...(selectedPlacement.machineReady ? {} : { subtitle: t('newSession.recipeComposerMachineNotReady') })}
                    rowTestID="server-start-draft-placement"
                    serverId={selectedTarget.serverId}
                    machine={machine}
                    path={directory}
                    onSelectPath={changeDirectory}
                    onSelectNoFolder={clearDirectory}
                    {...(placementCandidates ? { placementCandidates } : {})}
                />
            </ItemGroup>
            {/* Where its sessions are listed (the Session organization folder, not the working folder). */}
            {showFolder ? <ItemGroup>
                {folderChoosable ? (
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
                ) : (
                    <Item
                        testID="server-start-draft-folder"
                        title={t('settingsSession.sessionPlacement.title')}
                        detail={resolveSessionFolderSelectionLabel(retainedFolderId, organization.folderTargets)}
                        subtitle={t('newSession.recipeComposerFolderRetained')}
                        subtitleLines={0}
                        showChevron={false}
                    />
                )}
            </ItemGroup> : null}
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
        </SidePaneInspectorSections>
    );
}

const styles = StyleSheet.create((theme) => ({
    content: { paddingBottom: theme.space.s16 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s6, paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 },
    authoringChips: { maxWidth: '100%' },
    note: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    chipError: { ...Typography.variant('meta'), color: theme.colors.state.danger.foreground },
    toolsGroup: { paddingTop: 0 },
    error: { marginHorizontal: theme.space.s24, marginTop: theme.space.s12, color: theme.colors.state.danger.foreground },
}));
