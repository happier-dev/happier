import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

import { MachinePathBrowserModalEntry } from './MachinePathBrowserModalEntry';

type OpenMachinePathBrowserParams = Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
    currentUiContextCommandScope?: string;
    callerContext?: import('@happier-dev/protocol/actions/executor/types').ActionExecutorContext;
    commandBridge?: import('@/modal/types').BaseModalConfig['commandBridge'];
    webPortalTarget?: ModalPortalTarget;
}>;

/** A caller that takes the Machine back gets the picked folder with the Machine it lives on, and may change it. */
export function openMachinePathBrowserModal(params: OpenMachinePathBrowserParams & Readonly<{ allowMachineChange: true }>):
    Promise<Readonly<{ machineId: string; path: string }> | null>;
export function openMachinePathBrowserModal(params: OpenMachinePathBrowserParams): Promise<string | null>;
export async function openMachinePathBrowserModal(params: OpenMachinePathBrowserParams & Readonly<{ allowMachineChange?: boolean }>):
    Promise<string | Readonly<{ machineId: string; path: string }> | null> {
    const deferred = createDeferredOnce<Readonly<{ machineId: string; path: string }> | null>();
    Modal.show({
        commandBridge: params.commandBridge,
        webPortalTarget: params.webPortalTarget ?? null,
        component: MachinePathBrowserModalEntry,
        props: {
            machineId: params.machineId,
            serverId: params.serverId ?? null,
            title: params.title,
            initialPath: params.initialPath ?? null,
            includeFiles: params.includeFiles ?? false,
            selectionMode: params.selectionMode ?? 'directory',
            currentUiContextCommandScope: params.currentUiContextCommandScope,
            callerContext: params.callerContext,
            allowMachineChange: params.allowMachineChange === true,
            onResolve: (path: string | null, machineId?: string) => deferred.resolve(
                path === null ? null : { machineId: machineId ?? params.machineId, path }),
        },
        onRequestClose: () => deferred.resolve(null),
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            dimensions: { maxHeightRatio: 0.92 },
        },
    });
    const picked = await deferred.promise;
    return params.allowMachineChange === true ? picked : picked?.path ?? null;
}
