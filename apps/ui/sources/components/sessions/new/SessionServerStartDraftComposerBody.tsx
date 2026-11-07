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
import { SESSION_FOLDER_SELECTION_ROOT_ID, resolveSessionFolderSelectionLabel } from '@/components/sessions/organization/sessionFolderSelectionOptions';
import type { SessionServerStartDraftSeed } from './serverStartDraftComposer';
import type { SessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';

/** The recipe fields this composer edits through the Session-owned authoring controls, in reading order. */
const AGENT_FIELDS: readonly SessionAuthoringFieldId[] = [
    'agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides', 'permissionMode', 'profileId',
];
const TOOL_FIELDS: readonly SessionAuthoringFieldId[] = [
    'capabilitySelection', 'connectedServices', 'unlistedTools', 'allowedTools',
];

/** The same Session-owned fields inside an inline editor or its returning sheet. */
export function SessionServerStartDraftComposerBody(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    model: SessionServerStartDraftRecipe;
}>) {
    const { selectedTarget, selectedPlacement, machine, directory, setDirectory, setDirectoryEdited,
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
                    detail={directory.trim() ? formatPathRelativeToHome(directory, homeDir) : t('newSession.folder.noFolder')}
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
    back: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8, alignItems: 'flex-start' },
    toolsGroup: { paddingTop: 0 },
    error: { marginHorizontal: theme.space.s24, marginTop: theme.space.s12, color: theme.colors.state.danger.foreground },
}));
