import {
    startDirectPeerTransferServer,
} from '@/machines/transfer/directPeerTransport';

import {
    resolveStackTransferFinalizeRecoveryFault,
} from './transferFinalizeRecoveryFault';

export async function startStackDebugDirectPeerTransferServer(
    params: Parameters<typeof startDirectPeerTransferServer>[0],
): ReturnType<typeof startDirectPeerTransferServer> {
    const finalizeFileOperations = resolveStackTransferFinalizeRecoveryFault();
    return await startDirectPeerTransferServer({
        ...params,
        ...(finalizeFileOperations ? { finalizeFileOperations } : {}),
    });
}
