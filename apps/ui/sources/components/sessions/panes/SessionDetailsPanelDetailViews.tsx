import { SessionPaneLazyLoader } from './SessionPaneLazyLoader';
import { FileFindSeedHost } from '@/components/appShell/panes/fileFindSeedHost';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';

import type { SessionCommitDetailsViewProps } from '@/components/sessions/files/views/SessionCommitDetailsView';
import type { SessionFileDetailsViewProps } from '@/components/sessions/files/views/SessionFileDetailsView';
import type { SessionScmReviewDetailsViewProps } from '@/components/sessions/files/views/SessionScmReviewDetailsView';
import type { SessionScmStashDetailsViewProps } from '@/components/sessions/files/views/SessionScmStashDetailsView';

type SessionSubagentDetailsViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    scopeId: string;
    subagentId: string;
}>;

const loadSessionFileDetailsView = async () => (await import('@/components/sessions/files/views/SessionFileDetailsView')).SessionFileDetailsView;

export function SessionFileDetailsViewForPanel(props: SessionFileDetailsViewProps & Readonly<{ active?: boolean }>) {
    const scope = useWorkspaceScopeForSession(props.sessionId, props.serverId);
    if (!scope) return <SessionPaneLazyLoader testID="session-file-details-loading" load={loadSessionFileDetailsView} props={props} />;
    return <FileFindSeedHost destination={{ host: 'session', id: props.sessionId, scope, path: props.filePath }} active={props.active !== false}>
        {({ findSeed, consumeFindSeed }) => <SessionPaneLazyLoader testID="session-file-details-loading" load={loadSessionFileDetailsView}
            props={{ ...props, findSeed, onFindSeedConsumed: consumeFindSeed }} />}
    </FileFindSeedHost>;
}

const loadSessionCommitDetailsView = async () => (await import('@/components/sessions/files/views/SessionCommitDetailsView')).SessionCommitDetailsView;

export function SessionCommitDetailsViewForPanel(props: SessionCommitDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-commit-details-loading" load={loadSessionCommitDetailsView} props={props} />;
}

const loadSessionScmReviewDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmReviewDetailsView')).SessionScmReviewDetailsView;

export function SessionScmReviewDetailsViewForPanel(props: SessionScmReviewDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-scm-review-details-loading" load={loadSessionScmReviewDetailsView} props={props} />;
}

const loadSessionScmStashDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmStashDetailsView')).SessionScmStashDetailsView;

export function SessionScmStashDetailsViewForPanel(props: SessionScmStashDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-scm-stash-details-loading" load={loadSessionScmStashDetailsView} props={props} />;
}

const loadSessionSubagentDetailsView = async () => (await import('@/components/sessions/agents/details/SessionSubagentDetailsView')).SessionSubagentDetailsView;

export function SessionSubagentDetailsViewForPanel(props: SessionSubagentDetailsViewProps) {
    return <SessionPaneLazyLoader testID="session-subagent-details-loading" load={loadSessionSubagentDetailsView} props={props} />;
}
