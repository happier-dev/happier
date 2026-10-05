import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { NewSessionEmbeddedHostProvider, mergeNewSessionHostParams, type NewSessionHostParams } from '@/components/sessions/new/navigation/newSessionHost';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { matchWorkspaceRoutePatterns } from '@/components/appShell/workspace/workspaceRouteMatch';
import { useWorkflowCardModal } from '../run/useWorkflowCardModal';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';

const NewSessionScreen = React.lazy(() => import('@/components/sessions/new/NewSessionScreen').then((module) => ({ default: module.NewSessionScreen })));
type SessionTarget = Readonly<{ sessionId: string; serverId: string }>;

export type WorkflowAgentAuthoringDraftProps = Readonly<{
    draftId: string;
    serverId: string;
    isCurrent: () => boolean;
    /** Called once Send created the ordinary Session (04 §4.7). */
    onSessionCreated: (destination: string, target: SessionTarget) => void;
    /** The surface around it closes (the Create sheet); a pane keeps itself. */
    onClose?: () => void;
}>;

/**
 * The one ordinary New Session composer, prefilled by the seed builder, hosted wherever agent
 * authoring shows it: the Create sheet, or the editor's details pane Agent tab for Edit (07 S22).
 */
export function WorkflowAgentAuthoringDraft(props: WorkflowAgentAuthoringDraftProps) {
    const [params, setParams] = React.useState<NewSessionHostParams>({ draftId: props.draftId });
    const host = React.useMemo(() => ({
        params,
        setParams: (patch: Readonly<Record<string, unknown>>) => setParams((current) => mergeNewSessionHostParams(current, patch)),
        openDraft: (entry: Readonly<{ draftId: string; draftOrigin: 'ordinary' | null }>) => setParams({ draftId: entry.draftId }),
        onHandedOff: (destination: Parameters<ReturnType<typeof useRouter>['push']>[0]) => {
            if (!props.isCurrent() || typeof destination !== 'string') return;
            const match = matchWorkspaceRoutePatterns(['session/[id]'], destination);
            const serverId = new URLSearchParams(destination.split('?')[1] ?? '').get('serverId') ?? props.serverId;
            if (!match?.params.id || !serverId) return;
            props.onClose?.();
            props.onSessionCreated(destination, { sessionId: match.params.id, serverId });
        },
        demanded: true,
        createdSessionPresentation: 'inPlace' as const,
    }), [params, props]);
    return <NewSessionEmbeddedHostProvider host={host}>
        <React.Suspense fallback={null}><NewSessionScreen presentation="embedded" /></React.Suspense>
    </NewSessionEmbeddedHostProvider>;
}

function WorkflowAgentAuthoringSheet(props: CustomModalInjectedProps & Omit<WorkflowAgentAuthoringDraftProps, 'onClose'>) {
    return <WorkflowAgentAuthoringDraft {...props} onClose={props.onClose} />;
}

/**
 * Seeds one ordinary New Session draft with the seed builder's text and hands back its identity,
 * for a host that shows the composer in place (the editor's Agent tab) rather than in a sheet.
 */
export function seedWorkflowAgentDraft(
    seed: PluginUiNewSessionSeedV1 & Readonly<{ prompt: string }>,
    onDraft: (draft: Readonly<{ draftId: string; serverId: string; isCurrent: () => boolean }>) => void,
): void {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    seedAndOpenNewSession({ seed, scope: lifetime.scope, isCurrent: lifetime.isCurrent,
        navigateToNewSession: ({ draftId }) => onDraft({ draftId, serverId: lifetime.scope.serverId, isCurrent: lifetime.isCurrent }) });
}

/** Seeds the one ordinary composer. Send remains owned by New Session, not Workflows. */
export function useWorkflowAgentAuthoring(onSessionCreated?: (target: SessionTarget) => void, title = t('workflows.authoring.create')) {
    const router = useRouter();
    const wide = useDetailsPaneAvailable();
    const [entry, setEntry] = React.useState<Readonly<{ draftId: string; lifetime: NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>>; onSessionCreated?: (target: SessionTarget) => void }> | null>(null);
    const close = React.useCallback(() => setEntry(null), []);
    React.useEffect(() => {
        const retirement = entry?.lifetime.onRetire(close);
        return () => retirement?.dispose();
    }, [close, entry]);
    const sheetProps = React.useMemo(() => entry === null ? null : {
        draftId: entry.draftId,
        serverId: entry.lifetime.scope.serverId,
        isCurrent: entry.lifetime.isCurrent,
        onSessionCreated: (destination: string, target: SessionTarget) => {
            close();
            if (!entry.lifetime.isCurrent()) return;
            if (wide && entry.onSessionCreated) entry.onSessionCreated(target);
            else if (wide) router.push(`/workflows?authoringSessionId=${encodeURIComponent(target.sessionId)}&authoringServerId=${encodeURIComponent(target.serverId)}` as never);
            else router.push(destination as never);
        },
    }, [close, entry, router, wide]);
    useWorkflowCardModal({ open: entry !== null, component: WorkflowAgentAuthoringSheet, props: sheetProps,
        identity: entry?.draftId, title, subtitle: t('workflows.authoring.description'),
        testID: 'workflow-agent-authoring-sheet', onRequestClose: close });
    return React.useCallback((seed: PluginUiNewSessionSeedV1 & Readonly<{ prompt: string }>) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        seedAndOpenNewSession({ seed, scope: lifetime.scope, isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => setEntry({ draftId, lifetime, onSessionCreated }) });
    }, [onSessionCreated]);
}
