import * as React from 'react';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { WorkflowsColumn } from '@/components/workflows/column/WorkflowsColumn';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';

import { WorkflowsLibraryHome } from './WorkflowsLibraryHome';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { WorkflowAuthoringSessionPane } from '../authoring/WorkflowAuthoringSessionPane';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { t } from '@/text';
import { View } from 'react-native';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { NewAccountTriggerPopover } from '../triggers/AccountTriggersSection';
import { readAutomationEventAuthoringSeed } from '@/sync/domains/workflows/automationEventAuthoringSeed';
import { useWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

/**
 * `/workflows`. Beside the Workflows column, main shows the library home, which carries only what the
 * column lacks. Without the column — a phone, or a collapsed column — the column is the destination's
 * Definitions carries the same complete home with descriptions, counts and examples. Runs and
 * Account triggers remain reachable through the existing view and trigger owners.
 */
export const WorkflowsDestinationIndex = React.memo(function WorkflowsDestinationIndex() {
    const columnVisible = useAppShellColumn().columnVisible;
    const access = useWorkflowsDestinationAccess();
    const router = useRouter();
    const params = useLocalSearchParams<{ authoringSessionId?: string; authoringServerId?: string; automationUnavailable?: string; automationEventSeedId?: string; serverId?: string }>();
    const seedServerId = typeof params.serverId === 'string' ? params.serverId : null;
    const eventSeedId = typeof params.automationEventSeedId === 'string' ? params.automationEventSeedId : null;
    const eventAnchor = React.useRef<View>(null);
    const [closedEventSeedId, setClosedEventSeedId] = React.useState<string | null>(null);
    const wide = useDetailsPaneAvailable();
    const sessionId = typeof params.authoringSessionId === 'string' ? params.authoringSessionId : null;
    const hideWorkflowLabel = t('panes.mainColumn.hideWorkflow');
    const showWorkflowLabel = t('panes.mainColumn.showWorkflow');
    const workflowsName = t('workflows.title');
    const mainColumn = React.useMemo(() => ({
        hideLabel: hideWorkflowLabel,
        showLabel: showWorkflowLabel,
        identity: { name: workflowsName },
    }), [hideWorkflowLabel, showWorkflowLabel, workflowsName]);
    const close = () => router.setParams({ authoringSessionId: undefined, authoringServerId: undefined });
    const content = !columnVisible && (access.kind === 'workflows' || access.kind === 'triggersOnly')
        ? <WorkflowsColumn surface="page" {...(access.kind === 'workflows'
            ? { definitionsContent: <WorkflowsLibraryHome includeAccountTriggers /> } : {})} />
        : <WorkflowsGate surface="destination"><WorkflowsLibraryHome /></WorkflowsGate>;
    const main = <>{params.automationUnavailable === '1' ? <SurfaceStateCard testID="retired-automation-unavailable"
        size="line" kind="unavailable" title={t('workflows.triggers.legacy.notAvailable')} /> : null}
        <View ref={eventAnchor} style={{ flex: 1 }} collapsable={false}>{content}</View>
        {eventSeedId && eventSeedId !== closedEventSeedId
            ? <AutomationEventAuthoringDestination key={eventSeedId} seedId={eventSeedId} serverId={seedServerId}
                anchorRef={eventAnchor} onRequestClose={() => {
                    setClosedEventSeedId(eventSeedId);
                    router.setParams({ automationEventSeedId: undefined });
                }} /> : null}</>;
    if (wide && sessionId && access.kind === 'workflows') return <AppPaneScopeHost scopeId="workflows" main={main}
        mainColumn={mainColumn}
        destinationDetails={{ onClose: close, pane: <View style={{ flex: 1, minHeight: 0 }}>
            <PaneHeader title={t('workflows.authoring.agent')} onClose={close} />
            <WorkflowAuthoringSessionPane sessionId={sessionId} serverId={params.authoringServerId} active composer />
        </View> }} />;
    return main;
});

/** The Event catalog and form mount only for a real opener intent. */
function AutomationEventAuthoringDestination(props: Readonly<{
    seedId: string;
    serverId: string | null;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>) {
    const access = useWorkflowsDestinationAccess(props.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const activeScope = useActiveServerAccountScope();
    const seed = useWorkflowEditorDraftSeed(props.serverId && !binding ? null : props.seedId,
        readAutomationEventAuthoringSeed, props.serverId ? binding : undefined);
    // Event configuration consumes the active Account's catalog and its exact lifetime.
    if (access.kind !== 'workflows' || !seed.seed || !seed.lifetime?.isCurrent()
        || !areServerAccountScopesEqual(seed.lifetime.scope, activeScope)) {
        return <SurfaceStateCard size="line" kind="unavailable" testID="automation-event-authoring-unavailable"
            title={t('workflows.triggers.legacy.notAvailable')} />;
    }
    return <NewAccountTriggerPopover anchorRef={props.anchorRef} eventSeed={seed.seed}
        accountLifetime={seed.lifetime} onRequestClose={props.onRequestClose} />;
}
