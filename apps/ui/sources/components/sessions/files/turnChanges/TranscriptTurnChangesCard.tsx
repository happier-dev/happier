import * as React from 'react';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

import { TurnChangesCard } from './TurnChangesCard';

export type TranscriptTurnChangesCardProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    turnId: string;
    files: readonly ScmFileStatus[];
    /** Opens one file; absent where the viewer may not open files (a public or read-only transcript). */
    onOpenFile?: ((fullPath: string) => void) | null;
}>;

const noop = () => {};

/**
 * The turn-end card in the transcript (WT9-R): the turn's own Diff evidence, opening Files on exactly
 * this turn's comparison. Both entrances keep the turn identity even after the working copy changes.
 */
export const TranscriptTurnChangesCard = React.memo(function TranscriptTurnChangesCard(props: TranscriptTurnChangesCardProps) {
    const source = useSessionTranscriptSource();
    const rootPath = source.useWorkspacePath();
    const navigate = source.navigate;
    const canOpen = props.onOpenFile != null;
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
    const walkThrough = React.useMemo(() => {
        if (!navigate || !canOpen) return null;
        const href = buildSessionDetailsHref({
            sessionId: props.sessionId, serverId: props.serverId ?? null,
            details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: props.turnId }, view: 'walkthrough' },
        });
        return () => navigate(href);
    }, [canOpen, navigate, props.serverId, props.sessionId, props.turnId]);
    return (
        <TurnChangesCard
            testID={`turn-changes-card:${props.turnId}`}
            files={props.files}
            workspace={workspace}
            onOpenFile={props.onOpenFile ?? noop}
            onOpenInFiles={openInFiles}
            onWalkThrough={walkThrough}
        />
    );
});
