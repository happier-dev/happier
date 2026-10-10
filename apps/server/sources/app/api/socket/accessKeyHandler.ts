import { Socket } from "socket.io";
import { inTx } from "@/storage/inTx";
import { readSessionMachineBindingStateInTx, readSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { log } from "@/utils/logging/log";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { canReadAccessKeyFromSessionScopedSocket } from "./sessionScopedBinding";
import { hasCurrentSocketCredential } from "./socketCredentialCurrentness";

export function accessKeyHandler(userId: string, socket: Socket, connection: ClientConnection) {
    // Get access key via socket
    socket.on('access-key-get', async (data: { sessionId: string; machineId: string }, callback: (response: any) => void) => {
        try {
            const { sessionId, machineId } = data;

            if (!sessionId || !machineId) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: sessionId and machineId are required'
                    });
                }
                return;
            }
            if (!await canReadAccessKeyFromSessionScopedSocket({ socket, connection, sessionId, machineId })) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Forbidden'
                    });
                }
                return;
            }
            // The Session belongs to the requester, not necessarily the Machine
            // custodian. Read admission and the exact tuple together at their
            // canonical owner; retained ciphertext alone never grants access.
            const binding = { accountId: userId, machineId, sessionId };
            const result = await inTx(async tx => {
                if (await readSessionMachineBindingStateInTx(tx, binding) !== "available") {
                    return { admitted: false } as const;
                }
                return { admitted: true, accessKey: await readSessionMachineAccessKeyInTx(tx, binding) } as const;
            });
            if (!result.admitted) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Session or machine not found'
                    });
                }
                return;
            }

            if (!await hasCurrentSocketCredential(userId, socket)) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Forbidden'
                    });
                }
                socket.disconnect(true);
                return;
            }

            const { accessKey } = result;
            if (callback) {
                if (accessKey) {
                    callback({
                        ok: true,
                        accessKey: {
                            data: accessKey.data,
                            dataVersion: accessKey.dataVersion,
                            createdAt: accessKey.createdAt.getTime(),
                            updatedAt: accessKey.updatedAt.getTime()
                        }
                    });
                } else {
                    callback({
                        ok: true,
                        accessKey: null
                    });
                }
            }

            log({ module: 'websocket-access-key' }, `Access key retrieved for session ${sessionId}, machine ${machineId}`);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in access-key-get: ${error}`);
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });
}
