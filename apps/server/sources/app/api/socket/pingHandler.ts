import { log } from "@/utils/logging/log";
import { Socket } from "socket.io";
import {
    CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
    SessionSyncPendingInputCompatibilityPingAckV1Schema,
} from '@happier-dev/protocol';
import { resolveSessionSyncCompatibilityPolicy } from '@/app/clientCompatibility/policy';

export function pingHandler(
    socket: Socket,
    options: Readonly<{ env?: Readonly<Record<string, string | undefined>> }> = {},
) {
    socket.on('ping', async (callback: (response: any) => void) => {
        try {
            const policy = resolveSessionSyncCompatibilityPolicy(options.env ?? process.env);
            callback(SessionSyncPendingInputCompatibilityPingAckV1Schema.parse({
                v: 1,
                compatibility: {
                    v: 1,
                    sessionSync: policy.requirements,
                    pendingInput: {
                        currentPendingInputProtocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
                    },
                },
            }));
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in ping: ${error}`);
        }
    });
}
