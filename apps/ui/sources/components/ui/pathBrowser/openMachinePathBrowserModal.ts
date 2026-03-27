import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';

import { MachinePathBrowserModal } from './MachinePathBrowserModal';

export async function openMachinePathBrowserModal(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
}>): Promise<string | null> {
    const deferred = createDeferredOnce<string | null>();
    Modal.show({
        component: MachinePathBrowserModal,
        props: {
            machineId: params.machineId,
            serverId: params.serverId ?? null,
            title: params.title,
            initialPath: params.initialPath ?? null,
            includeFiles: params.includeFiles ?? false,
            selectionMode: params.selectionMode ?? 'directory',
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve(null),
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
