import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ScmCommitComposerCard } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { ScmChangeOverflowMenu } from '@/components/workspaces/scm/changes/ScmChangeOverflowMenu';
import { activeReviewFileKeyForWorkspace } from '@/components/workspaces/scm/review/activeReviewFile';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { resolveChangesGlanceFiles } from '@/components/sessions/companion/glances/glanceModels';
import { Typography } from '@/constants/Typography';
import { buildCommitSelectionPathHints, isFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

import { useWorkspaceScmCommitControls } from './useWorkspaceScmCommitControls';
import { applyWorkspaceFileStageAction, WorkspaceScmCommitSelectionToggleButton } from './WorkspaceScmCommitSelectionToggleButton';
import { applyWorkspaceFileDiscardAction } from './applyWorkspaceFileDiscardAction';

/**
 * Local changes (plan 14 §2, lab p-overview HOME/HOMEp): what this checkout has not committed and not
 * pushed, read from the same snapshot and selection as Changes, and the manual Commit and Push through
 * the checkout's one commit owner. No Session is needed to read or commit; a suggested message only
 * fills the draft through the same guarded detached Run owner as Git, and never commits.
 */
export const WorkspaceLocalChangesBody = React.memo(function WorkspaceLocalChangesBody(props: Readonly<{
    testID?: string;
    scope: WorkspaceScopeBase;
    /** Promotes the exact selected path into pending-changes Files review. */
    onOpenReview?: (path?: string) => void;
    onWalkThrough?: () => void;
    /** The machine isn't answering: the last state stays, said once with when it was true. */
    offline?: Readonly<{ asOf: number | null; reason: string }> | null;
}>) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'workspace-local-changes';
    const controls = useWorkspaceScmCommitControls(props.scope);
    const snapshot = controls.snapshot;
    const summary = React.useMemo(() => buildSessionScmSummary(snapshot), [snapshot]);
    const changedFiles = summary?.files ?? [];
    const added = summary?.linesAdded ?? 0;
    const removed = summary?.linesRemoved ?? 0;
    const ahead = snapshot?.branch.ahead ?? 0;
    const machine = useMachinePresenceSummary(props.scope.serverId, props.scope.machineId);
    const offline = props.offline ?? (snapshot && machine.reachability === 'unreachable'
        ? { asOf: snapshot.fetchedAt, reason: t('projects.code.offline') } : null);
    const presentation = useWidgetPresentation();
    const visibleCount = summary ? resolveChangesGlanceFiles(summary, presentation?.footprint.height === 'compact' ? 1
        : presentation?.footprint.height === 'tall' ? changedFiles.length : undefined).rows.length : 0;
    const selectedPaths = React.useMemo(() => new Set(buildCommitSelectionPathHints(controls)),
        [controls.commitSelectionPaths, controls.commitSelectionPatches]);
    const selected = (file: (typeof changedFiles)[number]) => isFileSelectedForCommit({
        commitStrategy: controls.scmCommitStrategy, file, atomicSelectionPaths: selectedPaths,
    });
    const selectionCount = isAtomicCommitStrategy(controls.scmCommitStrategy)
        ? selectedPaths.size : changedFiles.filter(selected).length;
    const [selectionModeUserOn, setSelectionModeUserOn] = React.useState(false);
    const writeEnabled = controls.scmWriteEnabled && offline == null;
    const selectionModeActive = writeEnabled && (selectionModeUserOn || selectionCount > 0);
    const reviewKey = activeReviewFileKeyForWorkspace(props.scope);
    const openChanges = props.onOpenReview ? () => props.onOpenReview?.() : null;

    if (!snapshot) {
        return controls.error ? (
            <SurfaceStateCard
                testID={`${testID}-error`}
                size="line"
                kind="error"
                title={t('projects.localChanges.unavailable')}
                diagnosticCode={controls.error.errorCode ?? controls.error.message}
                action={{ label: t('common.retry'), onPress: () => { void controls.refresh(); } }}
            />
        ) : (
            <SurfaceStateCard testID={`${testID}-loading`} size="line" kind="loading" title={t('common.loading')} />
        );
    }
    if (snapshot.repo.isRepo === false) {
        return <SurfaceStateCard testID={`${testID}-not-repo`} size="line" kind="empty" title={t('files.notRepo')} />;
    }

    const lines = (
        <Text style={styles.lines}>
            {added > 0 ? <Text style={[styles.lines, { color: theme.colors.state.success.foreground }]}>{`+${added.toLocaleString()}`}</Text> : null}
            {added > 0 && removed > 0 ? ' ' : null}
            {removed > 0 ? <Text style={[styles.lines, { color: theme.colors.state.danger.foreground }]}>{`−${removed.toLocaleString()}`}</Text> : null}
        </Text>
    );
    const clean = changedFiles.length === 0 && ahead === 0;

    return (
        <View testID={testID} style={styles.body}>
            {offline ? <SurfaceFreshnessLine testID={`${testID}-offline`} asOf={offline.asOf} reason={offline.reason} /> : null}
            {clean ? (
                <View testID={`${testID}-clean`} style={styles.row}>
                    <Icon name="check-circle" size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.quiet}>{t('projects.localChanges.clean')}</Text>
                </View>
            ) : null}
            {changedFiles.length > 0 ? (
                <HappierPressable
                    testID={`${testID}-files`}
                    accessibilityRole={openChanges ? 'button' : undefined}
                    disabled={!openChanges}
                    onPress={() => openChanges?.()}
                    style={(state) => [
                        styles.row,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        styles.pressableRow,
                        openChanges && (state.pressed || state.hovered) ? { backgroundColor: theme.colors.surface.pressed } : null,
                    ]}
                >
                    <Icon name="file" size={16} color={theme.colors.text.secondary} />
                    <Text numberOfLines={1} style={styles.label}>{t('projects.localChanges.filesNotCommitted', { count: changedFiles.length })}</Text>
                    {lines}
                    {openChanges ? <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} /> : null}
                </HappierPressable>
            ) : null}
            {props.onOpenReview ? changedFiles.slice(0, visibleCount).map(file => (
                <ScmChangeRow key={file.fullPath} theme={theme} file={file} density="compact" layout="compact"
                    activeReviewFileKey={reviewKey} onPress={() => props.onOpenReview?.(file.fullPath)}
                    leadingElement={selectionModeActive ? <WorkspaceScmCommitSelectionToggleButton
                        scope={props.scope} snapshot={snapshot} scmWriteEnabled={writeEnabled}
                        commitStrategy={controls.scmCommitStrategy} file={file} selectedForCommit={selected(file)} onAfterToggle={controls.refresh} /> : null}
                    onToggleSelection={writeEnabled ? () => { void applyWorkspaceFileStageAction({
                        scope: props.scope, filePath: file.fullPath, snapshot, scmWriteEnabled: writeEnabled,
                        commitStrategy: controls.scmCommitStrategy, stage: !selected(file), surface: 'files', onAfterToggle: controls.refresh,
                    }); } : undefined}
                    trailingElement={<ScmChangeOverflowMenu title={file.fileName} filePath={file.fullPath}
                        onDiscard={writeEnabled && snapshot.capabilities.writeDiscard ? () => fireAndForget(applyWorkspaceFileDiscardAction({
                            scope: props.scope, machineId: props.scope.machineId, rootPath: props.scope.rootPath,
                            file, snapshot, scmWriteEnabled: writeEnabled, commitStrategy: controls.scmCommitStrategy,
                            surface: 'files', refreshAll: controls.refresh,
                        }), { tag: 'WorkspaceLocalChangesBody.discard' }) : undefined} />} />
            )) : null}
            {props.onOpenReview && changedFiles.length > visibleCount ? <Text style={styles.quiet}>
                {t('widgetGlances.moreFiles', { count: changedFiles.length - visibleCount })}
            </Text> : null}
            {changedFiles.length > 0 && props.onWalkThrough ? <ToolbarButton
                label={t('turnChanges.card.walkThrough')} onPress={props.onWalkThrough} /> : null}
            {ahead > 0 ? (
                <View testID={`${testID}-ahead`} style={styles.row}>
                    <Icon name="arrow-up" size={16} color={theme.colors.text.secondary} />
                    <Text numberOfLines={1} style={styles.label}>{t('projects.localChanges.commitsToPush', { count: ahead })}</Text>
                    {controls.commitAdjacentPushAction ? (
                        <ToolbarButton
                            testID={`${testID}-push`}
                            label={t('projects.localChanges.push')}
                            accessibilityLabel={controls.commitAdjacentPushAction.label}
                            disabled={controls.commitAdjacentPushAction.disabled || offline != null}
                            busy={controls.commitAdjacentPushAction.busy}
                            onPress={controls.commitAdjacentPushAction.onPress}
                        />
                    ) : null}
                </View>
            ) : null}
            {changedFiles.length > 0 && writeEnabled && snapshot.capabilities.writeCommit ? (
                <ScmCommitComposerCard
                    theme={theme}
                    commitActionLabel={t('common.commit')}
                    draftMessage={controls.commitDraftMessage}
                    onDraftMessageChange={controls.setCommitDraftMessage}
                    busy={controls.scmOperationBusy}
                    status={controls.scmOperationStatus}
                    commitAllowed={controls.commitAllowed && offline == null}
                    commitBlockedMessage={controls.commitBlockedMessage}
                    onCommitFromMessage={controls.handleCommitFromMessage}
                    selectionSummary={{ fileCount: changedFiles.length, linesAdded: added, linesRemoved: removed }}
                    selectionCount={selectionCount}
                    onClearSelection={selectionCount > 0 ? controls.handleClearSelection : undefined}
                    onSelectAllSelection={isAtomicCommitStrategy(controls.scmCommitStrategy) ? () => storage.getState()
                        .markWorkspaceScmCommitSelectionPaths(props.scope, changedFiles.map(file => file.fullPath)) : undefined}
                    commitSelectionAvailable={writeEnabled} selectionModeActive={selectionModeActive}
                    onEnterSelectionMode={() => setSelectionModeUserOn(true)} onExitSelectionMode={() => setSelectionModeUserOn(false)}
                    pushShortcut={controls.commitAdjacentPushAction}
                    commitMessageGeneratorEnabled={controls.commitMessageGeneratorEnabled}
                    onGenerateCommitMessageSuggestion={controls.generateCommitMessageSuggestion}
                    onCancelCommitMessageSuggestion={controls.cancelCommitMessageSuggestion}
                    suggestionContextKey={controls.suggestionContextKey}
                />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 4,
    },
    row: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    pressableRow: {
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    label: {
        ...Typography.rowTitle(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    quiet: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    lines: {
        ...Typography.rowMeta(),
        ...Typography.mono(),
        ...Typography.tabular(),
    },
}));
