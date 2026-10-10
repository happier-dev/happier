import * as React from 'react';
import type { BuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { ProjectBuiltinWidgetBody } from '@/components/projects/widgets/ProjectBuiltinWidgetBody';
import { UsageWidgetBody, isUsageBuiltinWidgetId } from '@/components/settings/usage/widgets/UsageWidgetBody';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createAppSessionTranscriptActions } from '@/components/sessions/transcript/source/appSessionTranscriptActions';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useOpenApprovalArtifactsForSession } from '@/sync/domains/state/storage';
import { answerSessionPermission } from '@/sync/ops/sessionPermissionAnswers';
import { ChangesGlance } from './ChangesGlance';
import { LocalServicesGlance } from './LocalServicesGlance';
import { useSessionSummaryModel } from '../summary/useSessionSummaryModel';
import { SessionSummaryCard, type SessionSummaryAnswerPermission } from '../summary/SessionSummaryCard';
import { SessionAgentPlanCard } from '../plan/SessionAgentPlanCard';
import { createSessionSummaryDestinations } from '../summary/sessionSummaryDestinations';

/** Native bodies and actions, below the generic binder's exact readable Session. */
type SessionBodyProps = Readonly<{ id: BuiltinWidgetIdV1; session: Session; serverId: string; testID: string }>;
export function BuiltinWidgetBody(props: Readonly<{ id: BuiltinWidgetIdV1;
    target: Extract<ConfiguredWidgetTargetResolution, { status: 'ready' }>['target'];
    input: Readonly<Record<string, JsonValue>>; serverId: string; testID: string }>) {
    // App reads: Usage definitions resolve no Session/Workspace target; their admitted input is the query.
    if (props.target.kind === 'app' && isUsageBuiltinWidgetId(props.id)) return <UsageWidgetBody id={props.id}
        input={props.input} serverId={props.serverId} testID={props.testID} />;
    if (props.target.kind === 'workspace') return <ProjectBuiltinWidgetBody id={props.id}
        workspace={props.target.workspace} checkout={props.target.checkout} testID={props.testID} />;
    if (props.target.kind !== 'session' || !props.target.session) return <UnavailableInstalledWidget
        unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    const sessionProps = { id: props.id, session: props.target.session, serverId: props.serverId, testID: props.testID };
    if (props.id === 'changes') return <ChangesWidgetBody {...sessionProps} />;
    if (props.id === 'local_services') return <ServicesWidgetBody {...sessionProps} />;
    return <AppSessionTranscriptSourceProvider sessionId={sessionProps.session.id} serverId={props.serverId}>
        <SummaryWidgetBody {...sessionProps} />
    </AppSessionTranscriptSourceProvider>;
}

function ServicesWidgetBody(props: SessionBodyProps) {
    const router = useRouter();
    return <LocalServicesGlance {...props} sessionId={props.session.id} frameStyle="plain" presentation="body" measurementOnly={false}
        onAfterDetailsOpen={() => router.push(buildScopedSessionRouteHref({ sessionId: props.session.id,
            serverId: props.serverId, suffix: '/details' }) as Parameters<typeof router.push>[0])} />;
}

function ChangesWidgetBody(props: SessionBodyProps) {
    const router = useRouter();
    return <ChangesGlance {...props} sessionId={props.session.id} frameStyle="plain" presentation="body" measurementOnly={false}
        onOpenReview={target => router.push(buildSessionDetailsHref({ sessionId: props.session.id, serverId: props.serverId,
            details: { kind: 'scmReview', ...target } }) as Parameters<typeof router.push>[0])} />;
}

function SummaryWidgetBody(props: SessionBodyProps) {
    const model = useSessionSummaryModel({ session: props.session, serverId: props.serverId });
    const router = useRouter();
    const approvals = useOpenApprovalArtifactsForSession({ sessionId: props.session.id, serverId: props.serverId });
    const destinations = React.useMemo(() => createSessionSummaryDestinations({
        address: { sessionId: props.session.id, serverId: props.serverId },
        navigate: href => router.push(href as Parameters<typeof router.push>[0]),
        approvalId: approvals[0]?.artifact.id,
    }), [approvals, props.serverId, props.session.id, router]);
    const actions = React.useMemo(() => createAppSessionTranscriptActions(props.session.id, props.serverId), [props.session.id, props.serverId]);
    const answerPermission = React.useCallback<SessionSummaryAnswerPermission>((request, answer) => answerSessionPermission({
        requestId: request.requestId, ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
        toolName: request.toolName, answer, policy: request.policy, respondToPermission: actions.respondToPermission,
    }), [actions]);
    return props.id === 'agent_plan'
        ? <SessionAgentPlanCard plan={model.plan} agentLabel={model.agentLabel}
            activity={model.needsYou ? 'held' : model.status?.state === 'thinking' ? 'working' : 'idle'}
            presentation="body" testID={props.testID} />
        : <SessionSummaryCard model={model} session={props.session} serverId={props.serverId}
            density="comfortable" presentation="full" answerPermission={answerPermission} destinations={destinations}
            onOpenFullSurface={() => router.push(buildScopedSessionRouteHref({ sessionId: props.session.id,
                serverId: props.serverId }) as Parameters<typeof router.push>[0])} testID={props.testID} />;
}
