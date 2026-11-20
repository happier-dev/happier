import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { ManagedWorkspaceLocatorV2Schema, type ManagedWorkspaceLocatorV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { MachinePathBrowserModalEntry } from './MachinePathBrowserModalEntry';
import type { ManagedWorkspacePreparationRequest } from './ManagedWorkspacePreparation';

type OpenPathBrowserOptions = Readonly<{
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    currentUiContextCommandScope?: string;
    callerContext?: import('@happier-dev/protocol/actions/executor/types').ActionExecutorContext;
    commandBridge?: import('@/modal/types').BaseModalConfig['commandBridge'];
    webPortalTarget?: ModalPortalTarget;
}>;

type OpenMachinePathBrowserParams = OpenPathBrowserOptions & Readonly<{
    machineId: string;
    serverId?: string | null;
    allowMachineChange?: boolean;
}>;
type OpenManagedPathBrowserParams = OpenPathBrowserOptions & Readonly<{
    workspace: Pick<ManagedWorkspaceLocatorV2, 'serverId' | 'managedId' | 'controller'>
        & Partial<Pick<ManagedWorkspaceLocatorV2, 'rootPath'>>;
    initialPath: string;
}>;

/** A workspace with no access yet (an attachment before its Project exists): prepared, then browsed in its guest. */
type OpenPreparedManagedPathBrowserParams = OpenPathBrowserOptions & Readonly<{
    prepare: ManagedWorkspacePreparationRequest;
    /** The controller the workspace is reached through, named on the chooser while it prepares. */
    controllerMachineId: string;
}>;

/** A caller that takes the Machine back gets the picked folder with the Machine it lives on, and may change it. */
export function openMachinePathBrowserModal(params: OpenMachinePathBrowserParams & Readonly<{ allowMachineChange: true }>):
    Promise<Readonly<{ machineId: string; path: string }> | null>;
export function openMachinePathBrowserModal(params: OpenManagedPathBrowserParams): Promise<Readonly<{ path: string }> | null>;
export function openMachinePathBrowserModal(params: OpenPreparedManagedPathBrowserParams):
    Promise<Readonly<{ path: string; workspace: ManagedWorkspaceLocatorV2 }> | null>;
export function openMachinePathBrowserModal(params: OpenMachinePathBrowserParams): Promise<string | null>;
export async function openMachinePathBrowserModal(
    params: OpenMachinePathBrowserParams | OpenManagedPathBrowserParams | OpenPreparedManagedPathBrowserParams,
): Promise<string | Readonly<{ machineId?: string; path: string; workspace?: ManagedWorkspaceLocatorV2 }> | null> {
    if ('prepare' in params) {
        const prepared: { workspace: ManagedWorkspaceLocatorV2 | null } = { workspace: null };
        const deferred = createDeferredOnce<string | null>();
        Modal.show({
            commandBridge: params.commandBridge,
            webPortalTarget: params.webPortalTarget ?? null,
            component: MachinePathBrowserModalEntry,
            props: {
                machineId: params.controllerMachineId,
                serverId: params.prepare.serverId,
                prepare: params.prepare,
                onPrepared: (workspace: ManagedWorkspaceLocatorV2) => { prepared.workspace = workspace; },
                title: params.title,
                initialPath: params.initialPath ?? null,
                includeFiles: false,
                selectionMode: 'directory',
                currentUiContextCommandScope: params.currentUiContextCommandScope,
                callerContext: params.callerContext,
                allowMachineChange: false,
                onResolve: (path: string | null) => deferred.resolve(path),
            },
            onRequestClose: () => deferred.resolve(null),
            closeOnBackdrop: true,
            chrome: { kind: 'card', dimensions: { maxHeightRatio: 0.92 } },
        });
        const path = await deferred.promise;
        const workspace = prepared.workspace;
        return path && workspace ? { path, workspace } : null;
    }
    const target = 'workspace' in params ? ManagedWorkspaceLocatorV2Schema.safeParse({
        v: 2, kind: 'managed',
        serverId: params.workspace.serverId, managedId: params.workspace.managedId,
        controller: params.workspace.controller, rootPath: params.workspace.rootPath ?? params.initialPath,
    }) : null;
    if (target?.success === false) return null;
    const workspace = target?.data;
    const machineId = 'workspace' in params ? params.workspace.controller.machineId : params.machineId;
    const serverId = 'workspace' in params ? params.workspace.serverId : params.serverId;
    const allowMachineChange = 'allowMachineChange' in params && params.allowMachineChange === true;
    const deferred = createDeferredOnce<Readonly<{ machineId: string; path: string }> | null>();
    Modal.show({
        commandBridge: params.commandBridge,
        webPortalTarget: params.webPortalTarget ?? null,
        component: MachinePathBrowserModalEntry,
        props: {
            machineId,
            serverId: serverId ?? null,
            ...(workspace ? { workspace } : {}),
            title: params.title,
            initialPath: params.initialPath ?? null,
            includeFiles: params.includeFiles ?? false,
            selectionMode: params.selectionMode ?? 'directory',
            currentUiContextCommandScope: params.currentUiContextCommandScope,
            callerContext: params.callerContext,
            allowMachineChange,
            onResolve: (path: string | null, pickedMachineId?: string) => deferred.resolve(
                path === null ? null : { machineId: pickedMachineId ?? machineId, path }),
        },
        onRequestClose: () => deferred.resolve(null),
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            dimensions: { maxHeightRatio: 0.92 },
        },
    });
    const picked = await deferred.promise;
    if (workspace) return picked ? { path: picked.path } : null;
    return allowMachineChange ? picked : picked?.path ?? null;
}
