import { DestinationBodyLoading } from '@/components/appShell/workspace/DestinationBodyLoading';
import { SessionPaneLazyLoader, type SessionPaneLazyLoaderProps } from './SessionPaneLazyLoader';
import { FileFindSeedHost } from '@/components/appShell/panes/fileFindSeedHost';
import { useSessionFileScope } from '@/components/sessions/files/views/useSessionFileScope';

import type { SessionCommitDetailsViewProps } from '@/components/sessions/files/views/SessionCommitDetailsView';
import type { SessionFileDetailsViewProps } from '@/components/sessions/files/views/SessionFileDetailsView';
import type { SessionScmReviewDetailsViewProps } from '@/components/sessions/files/views/SessionScmReviewDetailsView';
import type { SessionScmStashDetailsViewProps } from '@/components/sessions/files/views/SessionScmStashDetailsView';

function SessionDetailsViewLoader<TProps extends object>(
    props: Omit<SessionPaneLazyLoaderProps<TProps>, 'loadingFallback'>,
) {
    return <SessionPaneLazyLoader {...props}
        loadingFallback={<DestinationBodyLoading testID={props.testID} holdLaunchCurtain={false} />} />;
}

type SessionSubagentDetailsViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    scopeId: string;
    subagentId: string;
}>;

const loadSessionFileDetailsView = async () => (await import('@/components/sessions/files/views/SessionFileDetailsView')).SessionFileDetailsView;

export function SessionFileDetailsViewForPanel(props: SessionFileDetailsViewProps & Readonly<{ active?: boolean }>) {
    const scope = useSessionFileScope(props.sessionId, props.serverId, props.initialView?.rootPath);
    if (!scope) return <SessionDetailsViewLoader testID="session-file-details-loading" load={loadSessionFileDetailsView} props={props} />;
    return <FileFindSeedHost destination={{ host: 'session', id: props.sessionId, scope, path: props.filePath }} active={props.active !== false}>
        {({ findSeed, consumeFindSeed }) => <SessionDetailsViewLoader testID="session-file-details-loading" load={loadSessionFileDetailsView}
            props={{ ...props, findSeed, onFindSeedConsumed: consumeFindSeed }} />}
    </FileFindSeedHost>;
}

const loadSessionCommitDetailsView = async () => (await import('@/components/sessions/files/views/SessionCommitDetailsView')).SessionCommitDetailsView;

export function SessionCommitDetailsViewForPanel(props: SessionCommitDetailsViewProps) {
    return <SessionDetailsViewLoader testID="session-commit-details-loading" load={loadSessionCommitDetailsView} props={props} />;
}

const loadSessionScmReviewDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmReviewDetailsView')).SessionScmReviewDetailsView;

export function SessionScmReviewDetailsViewForPanel(props: SessionScmReviewDetailsViewProps) {
    return <SessionDetailsViewLoader testID="session-scm-review-details-loading" load={loadSessionScmReviewDetailsView} props={props} />;
}

const loadSessionScmStashDetailsView = async () => (await import('@/components/sessions/files/views/SessionScmStashDetailsView')).SessionScmStashDetailsView;

export function SessionScmStashDetailsViewForPanel(props: SessionScmStashDetailsViewProps) {
    return <SessionDetailsViewLoader testID="session-scm-stash-details-loading" load={loadSessionScmStashDetailsView} props={props} />;
}

const loadSessionSubagentDetailsView = async () => (await import('@/components/sessions/agents/details/SessionSubagentDetailsView')).SessionSubagentDetailsView;

export function SessionSubagentDetailsViewForPanel(props: SessionSubagentDetailsViewProps) {
    return <SessionDetailsViewLoader testID="session-subagent-details-loading" load={loadSessionSubagentDetailsView} props={props} />;
}
