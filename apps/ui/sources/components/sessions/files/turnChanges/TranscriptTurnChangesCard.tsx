import * as React from 'react';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useTranscriptFileLinks } from '@/components/sessions/transcript/useTranscriptFileLinks';
import type { ReviewCommentAnchor } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import { useMachineField, useServerScopedMachineLabel } from '@/sync/store/hooks';
import { useSessionProjectScmRootPath } from '@/sync/store/scmHooks';
import { captureScmComparisonForSession } from '@/sync/ops/scmDiffSummary/generate';
import { scmComparisonSourceOf } from '@/sync/domains/scm/diffSummary/selection';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';

import { TurnChangesCard } from './TurnChangesCard';
import { openProjectFilesReturn } from './projectFilesReturn/ProjectFilesReturnModal';
import { useSessionProjectFilesReturnSource } from './projectFilesReturn/useSessionProjectFilesReturnSource';

export type TranscriptTurnChangesCardProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    turnId: string;
    files: readonly ScmFileStatus[];
    /** Set only by canonical checkpoint projection; legacy provider paths retain the Session base. */
    repositoryRelative?: boolean;
    firstHunkAnchors?: Readonly<Record<string, ReviewCommentAnchor>>;
    messageId?: string;
    /** Public/read-only sources cannot open private workspace files. */
    fileOpenEnabled?: boolean;
}>;

/**
 * The turn-end card in the transcript (WT9-R): the turn's own Diff evidence, opening Files on exactly
 * this turn's comparison. Both entrances keep the turn identity even after the working copy changes.
 */
export const TranscriptTurnChangesCard = React.memo(function TranscriptTurnChangesCard(props: TranscriptTurnChangesCardProps) {
    const source = useSessionTranscriptSource();
    const rootPath = source.useWorkspacePath();
    const repositoryRoot = useSessionProjectScmRootPath(props.sessionId, props.serverId);
    const [openedRepositoryRoot, setOpenedRepositoryRoot] = React.useState<string>();
    const navigate = source.navigate;
    const canOpen = props.fileOpenEnabled === true;
    const { openPath, canOpen: canOpenFileLinks } = useTranscriptFileLinks({
        sessionId: props.sessionId, serverId: props.serverId,
        workspacePath: rootPath, canOpenFiles: canOpen, routeMessageId: props.messageId,
    });
    const openInFiles = React.useMemo(() => {
        if (!navigate || !canOpen) return null;
        const href = buildSessionDetailsHref({
            sessionId: props.sessionId,
            serverId: props.serverId ?? null,
            details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: props.turnId }, view: 'files' },
        });
        return () => navigate(href);
    }, [canOpen, navigate, props.serverId, props.sessionId, props.turnId]);
    const workspace = React.useMemo(() => ({ serverId: props.serverId ?? null, rootPath }), [props.serverId, rootPath]);
    const frontSession = React.useMemo(() => (canOpen ? { sessionId: props.sessionId, serverId: props.serverId ?? null, rootPath: props.repositoryRelative ? repositoryRoot ?? openedRepositoryRoot : undefined } : null),
        [canOpen, props.sessionId, props.serverId, props.repositoryRelative, repositoryRoot, openedRepositoryRoot]);
    const openFile = React.useCallback((path: string) => {
        if (!canOpenFileLinks) return;
        fireAndForget((async () => {
            const anchor = props.firstHunkAnchors?.[path];
            const options = { view: 'changes' as const, changesScope: { kind: 'turn' as const, turnId: props.turnId },
                ...(anchor ? { anchor, anchorSource: 'diff' as const } : {}) };
            if (!props.repositoryRelative) { openPath(path, options); return; }
            // Checkpoint projection gives every file a repository-relative identity. Resolve its base
            // only on a click when the existing Session snapshot does not already know it.
            let fileRoot = storage.getState().getSessionProjectScmSnapshot(props.sessionId, props.serverId)?.repo.rootPath ?? openedRepositoryRoot;
            if (!fileRoot) {
                if (!rootPath) return;
                const result = await captureScmComparisonForSession({ sessionId: props.sessionId, serverId: props.serverId,
                    input: { cwd: rootPath, source: scmComparisonSourceOf({ kind: 'turnCheckpoint', turnId: props.turnId }, props.sessionId) } });
                if (!result.success) { await Modal.alertAsync(t('common.error'), result.error); return; }
                fileRoot = result.comparison.repository.rootPath;
            }
            setOpenedRepositoryRoot(fileRoot);
            openPath(path, { ...options, rootPath: fileRoot });
        })(), { tag: 'TranscriptTurnChangesCard.openFile' });
    }, [canOpenFileLinks, openPath, openedRepositoryRoot, props.firstHunkAnchors, props.repositoryRelative, props.serverId, props.sessionId, props.turnId, rootPath]);
    const walkThrough = React.useMemo(() => {
        if (!navigate || !canOpen) return null;
        const href = buildSessionDetailsHref({
            sessionId: props.sessionId, serverId: props.serverId ?? null,
            details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: props.turnId }, view: 'walkthrough' },
        });
        return () => navigate(href);
    }, [canOpen, navigate, props.serverId, props.sessionId, props.turnId]);
    // A copied Session brings the sandbox's changes back to its recorded source folder, reviewed first.
    const returnSource = useSessionProjectFilesReturnSource(props.sessionId, props.serverId);
    const sourceMachineName = useServerScopedMachineLabel(returnSource?.serverId ?? null, returnSource?.machineId ?? null);
    const sourceHomeDir = useMachineField(returnSource?.machineId ?? '', 'metadata', 'homeDir',
        { enabled: returnSource !== null, serverId: returnSource?.serverId ?? null });
    const bringBack = React.useMemo(() => canOpen && returnSource ? () => openProjectFilesReturn({
        sessionId: props.sessionId, source: returnSource, machineName: sourceMachineName ?? t('common.machine'), homeDir: sourceHomeDir,
    }) : null, [canOpen, props.sessionId, returnSource, sourceHomeDir, sourceMachineName]);
    return (
        <TurnChangesCard
            onBringBack={bringBack}
            testID={`turn-changes-card:${props.turnId}`}
            files={props.files}
            messageId={props.messageId}
            workspace={workspace}
            onOpenFile={openFile}
            frontSession={frontSession}
            onOpenInFiles={openInFiles}
            onWalkThrough={walkThrough}
        />
    );
});
