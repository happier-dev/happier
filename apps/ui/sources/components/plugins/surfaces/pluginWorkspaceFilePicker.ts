import {
    PluginUiPickWorkspaceFileRequestV1Schema,
    PluginUiPickWorkspaceFileResultV1Schema,
    type PluginUiHostApiSurfaceTargetV1,
} from '@happier-dev/protocol/plugins/ui';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { isAbsoluteLocalPath, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

export function createPluginWorkspaceFilePicker(input: Readonly<{
    readTarget: () => PluginUiHostApiSurfaceTargetV1 | undefined;
    lifetimeSignal: AbortSignal;
}>): PluginSurfaceHostApiMethodHandler {
    return async (request, options) => {
        if (!PluginUiPickWorkspaceFileRequestV1Schema.safeParse(request.payload).success) {
            return createPluginSurfaceHostApiError('invalid_payload', ['pick_workspace_file_payload_invalid']);
        }
        const target = input.readTarget();
        const checkout = target?.kind === 'project' ? target.checkout
            : target?.kind === 'session' || target?.kind === 'services' ? target.project?.checkout : undefined;
        const root = checkout?.rootPath.replace(/\\/g, '/');
        if (!checkout || !root || !isAbsoluteLocalPath(root)) {
            return { kind: 'unavailable', reason: 'checkout_unavailable' };
        }
        const merged = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        try {
            const path = await openMachinePathBrowserModal({
                machineId: checkout.machineId,
                serverId: checkout.serverId,
                rootDirectoryPath: root,
                selectionMode: 'file',
                signal: merged.signal,
            });
            if (path === null) return { kind: 'cancelled' };
            const relativePath = resolvePathRelativeToRoot({ path, root, preservePathSpelling: true });
            const picked = PluginUiPickWorkspaceFileResultV1Schema.safeParse({ kind: 'picked', relativePath });
            return picked.success ? picked.data : { kind: 'unavailable', reason: 'outside_checkout' };
        } finally {
            merged.dispose();
        }
    };
}
