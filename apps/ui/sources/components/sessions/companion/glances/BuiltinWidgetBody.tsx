import * as React from 'react';
import type { BuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { ProjectBuiltinWidgetBody } from '@/components/projects/widgets/ProjectBuiltinWidgetBodyHost';
import { UsageWidgetBody } from '@/components/settings/usage/widgets/UsageWidgetBodyHost';
import { isUsageBuiltinWidgetId } from '@/components/settings/usage/widgets/usageBuiltinWidgetId';
import { YourHomeWidgetBody } from '@/components/hub/yourHome/YourHomeWidgetBody';
import { MachineWidgetBody, isMachineBuiltinWidgetId } from '@/components/machines/widgets/MachineWidgetBody';
import type { Session } from '@/sync/domains/state/storageTypes';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useOpenApprovalArtifactsForSession } from '@/sync/domains/state/storage';
import { ChangesGlance } from './ChangesGlance';
import { EnvironmentGlance } from './EnvironmentGlance';
import { LinksGlance } from './LinksGlance';
import { RunningGlance } from './RunningGlance';
import { UsageGlance } from './UsageGlance';
import { AppLocalServicesGlance, LocalServicesGlance } from './LocalServicesGlance';
import { useSessionSummaryModel } from '../summary/useSessionSummaryModel';
import { SessionSummaryCard } from '../summary/SessionSummaryCard';
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
    // Machine widgets: App reads whose admitted input names the machine (or, Activity, all machines).
    if (props.target.kind === 'app' && isMachineBuiltinWidgetId(props.id)) return <MachineWidgetBody id={props.id}
        input={props.input} serverId={props.serverId} testID={props.testID} />;
    // The active Home's machines and sessions: an App read with no inputs.
    if (props.target.kind === 'app' && props.id === 'your_home') return <YourHomeWidgetBody testID={props.testID} />;
    if (props.target.kind === 'app' && props.id === 'local_services_app') return <AppLocalServicesGlance serverId={props.serverId} testID={props.testID} />;
    if (props.target.kind === 'project' && props.id === 'project_readiness') return <ProjectBuiltinWidgetBody
        id={props.id} target={props.target} testID={props.testID} />;
    if (props.target.kind === 'workspace' && props.id !== 'project_readiness') return <ProjectBuiltinWidgetBody id={props.id}
        workspace={props.target.workspace} checkout={props.target.checkout} testID={props.testID} />;
    if (props.target.kind !== 'session' || !props.target.session) return <UnavailableInstalledWidget
        unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    const sessionProps = { id: props.id, session: props.target.session, serverId: props.serverId, testID: props.testID };
    if (props.id === 'changes') return <ChangesWidgetBody {...sessionProps} />;
    if (props.id === 'local_services') return <ServicesWidgetBody {...sessionProps} />;
    if (props.id === 'environment' || props.id === 'running' || props.id === 'usage' || props.id === 'links') return <SectionWidgetBody {...sessionProps} />;
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

/** A Companion row section as a copy elsewhere: its rows, opening the Session where a row leads to a pane. */
function SectionWidgetBody(props: SessionBodyProps) {
    const router = useRouter();
    const common = { session: props.session, sessionId: props.session.id, serverId: props.serverId, frameStyle: 'plain' as const,
        presentation: 'body' as const, measurementOnly: false, testID: props.testID };
    const openSession = () => router.push(buildScopedSessionRouteHref({ sessionId: props.session.id, serverId: props.serverId }) as Parameters<typeof router.push>[0]);
    switch (props.id) {
        case 'environment': return <EnvironmentGlance {...common} onOpenPane={openSession} />;
        case 'running': return <RunningGlance {...common} onOpenPane={openSession} />;
        case 'usage': return <UsageGlance {...common} />;
        default: return <LinksGlance {...common} />;
    }
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
    return props.id === 'agent_plan'
        ? <SessionAgentPlanCard plan={model.plan} agentLabel={model.agentLabel}
            activity={model.needsYou ? 'held' : model.status?.state === 'thinking' ? 'working' : 'idle'}
            presentation="body" testID={props.testID} />
        : <SessionSummaryCard model={model} session={props.session} serverId={props.serverId}
            density="comfortable" presentation="full" destinations={destinations}
            onOpenFullSurface={() => router.push(buildScopedSessionRouteHref({ sessionId: props.session.id,
                serverId: props.serverId }) as Parameters<typeof router.push>[0])} testID={props.testID} />;
}
