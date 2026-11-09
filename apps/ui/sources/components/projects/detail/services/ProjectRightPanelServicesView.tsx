import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import { createProjectServicePlacementRenderer } from './ProjectServicePlacementControls';
import { isProjectServiceTargetFromSource } from './projectServiceSource';
import { ProjectServicePlacementObservationProvider } from './projectServicePlacementObservation';
import { useProjectDefinitionInspection } from '@/components/projects/projectSetup/useProjectDefinitionInspection';
import { describeProjectCommandSource, findProjectInvocation } from '@/components/projects/projectSetup/projectScriptPresentation';
import type { DescribeServiceDeclaration } from '@/sync/domains/local/services/serviceRow';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ServiceRowOpenHandler } from '@/components/sessions/localServices/ServiceRowView';
import type { FrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';

export type ProjectRightPanelServicesViewProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    /** The SOURCE checkout's accepted ref: service placement is saved there, never on a worker copy. */
    workspaceRefId?: string | null;
    workspaceRoot?: string | null;
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** The Services page leads with its purpose; the rail keeps the pane chrome. Same body. */
    presentation?: 'pane' | 'page';
    /** The Project's own way to declare a service; the empty state offers it. */
    onAddService?: () => void;
    testID?: string;
}>;

export function ProjectRightPanelServicesView(props: ProjectRightPanelServicesViewProps = {}): React.ReactElement {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId ?? '');
    const workspace = React.useMemo<WorkspaceAddressV1 | null>(() => props.serverId && props.machineId && props.workspaceRefId && props.workspaceRoot
        ? { serverId: props.serverId, machineId: props.machineId, workspaceId: props.workspaceRefId, rootPath: props.workspaceRoot } : null,
    [props.machineId, props.serverId, props.workspaceRefId, props.workspaceRoot]);
    const inspection = useProjectDefinitionInspection(workspace, binding, { kind: 'services' });
    const declarations = React.useMemo(() => {
        const document = inspection.read && 'value' in inspection.read ? inspection.read.value.definition.document : null;
        const currentnessKey = document?.status === 'valid' ? JSON.stringify(document.manifest) : undefined;
        return document?.status === 'valid' ? Object.fromEntries(Object.entries(document.manifest.services ?? {}).map(([name, service]) =>
            [name, { portable: service.execution === 'portable', currentnessKey }])) : {};
    }, [inspection.read]);
    const placementSource = React.useMemo(() => props.serverId && props.machineId && props.workspaceRefId
        ? { serverId: props.serverId, machineId: props.machineId, refId: props.workspaceRefId,
            ...(props.workspaceRoot ? { rootPath: props.workspaceRoot } : {}) } : null,
    [props.machineId, props.serverId, props.workspaceRefId, props.workspaceRoot]);
    // What a declared service runs, in the Scripts page's own words ("yarn storybook", the file it comes from).
    const describeDeclaration = React.useMemo<DescribeServiceDeclaration | undefined>(() => {
        if (!inspection.read || !('value' in inspection.read)) return undefined;
        const { value } = inspection.read;
        const document = value.definition.document;
        return (declaration, target) => {
            if (!placementSource || !isProjectServiceTargetFromSource(placementSource, target)) return null;
            const { selection } = declaration;
            const source = selection.kind === 'native'
                ? selection.source
                : document?.status === 'valid' ? document.manifest.services?.[selection.name]?.source : undefined;
            if (!source) return null;
            const { command, badge } = describeProjectCommandSource(source, findProjectInvocation(value, source));
            return { command, badge };
        };
    }, [inspection.read, placementSource]);
    const renderServicePlacement = React.useMemo(() => createProjectServicePlacementRenderer(placementSource, declarations),
        [declarations, placementSource]);
    const body = (
        <LocalServicesSurfaceHost
            machineId={props.machineId}
            serverId={props.serverId}
            workspaceRoot={props.workspaceRoot}
            workspaceRefId={props.workspaceRefId}
            scope="workspace"
            inventoryState={props.inventoryState}
            launcherState={props.launcherState}
            launcherSnapshotClient={props.launcherSnapshotClient}
            publicPreviewState={props.publicPreviewState}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            runtimeActionExecute={props.runtimeActionExecute}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            presentation={props.presentation}
            onAddService={props.onAddService}
            renderServicePlacement={renderServicePlacement}
            describeDeclaration={describeDeclaration}
            testID={props.testID ?? 'project-rightpanel-services'}
        />
    );
    return placementSource ? <ProjectServicePlacementObservationProvider source={placementSource} runtimeActionExecute={props.runtimeActionExecute}>{body}</ProjectServicePlacementObservationProvider> : body;
}
