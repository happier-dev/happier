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
    const params = useLocalSearchParams<{ authoringSessionId?: string; authoringServerId?: string; automationUnavailable?: string; serverId?: string }>();
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
    const content = !columnVisible && access.kind === 'workflows'
        ? <WorkflowsColumn surface="page" definitionsContent={<WorkflowsLibraryHome />} />
        : <WorkflowsGate surface="destination"><WorkflowsLibraryHome /></WorkflowsGate>;
    const main = <>{params.automationUnavailable === '1' ? <SurfaceStateCard testID="retired-automation-unavailable"
        size="line" kind="unavailable" title={t('workflows.triggers.legacy.notAvailable')} /> : null}
        <View style={{ flex: 1 }} collapsable={false}>{content}</View>
        </>;
    if (wide && sessionId && access.kind === 'workflows') return <AppPaneScopeHost scopeId="workflows" main={main}
        mainColumn={mainColumn}
        destinationDetails={{ onClose: close, pane: <View style={{ flex: 1, minHeight: 0 }}>
            <PaneHeader title={t('workflows.authoring.agent')} onClose={close} />
            <WorkflowAuthoringSessionPane sessionId={sessionId} serverId={params.authoringServerId} active composer />
        </View> }} />;
    return main;
});
