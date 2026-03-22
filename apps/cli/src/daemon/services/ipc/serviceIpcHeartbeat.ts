import type { z } from 'zod';

import type {
    ServiceIpcConfigUpdateMessage,
    ServiceIpcHeartbeatMessage,
    ServiceIpcMessage,
    ServiceIpcStatusUpdateMessage,
} from './serviceIpcContract';
import { createServiceIpcMessageBuilder } from './serviceIpcMessages';

type AnyServiceIpcContract = Readonly<{
    service: string;
    HeartbeatMessageSchema: z.ZodType<ServiceIpcHeartbeatMessage<string>>;
    ConfigUpdateMessageSchema: z.ZodType<ServiceIpcConfigUpdateMessage<string, unknown>>;
    StatusUpdateMessageSchema: z.ZodType<ServiceIpcStatusUpdateMessage<string, unknown>>;
    ServiceMessageSchema: z.ZodType<ServiceIpcMessage<string, unknown, unknown>>;
}>;

type MessageOf<Contract extends AnyServiceIpcContract> = z.infer<Contract['ServiceMessageSchema']>;
type HeartbeatOf<Contract extends AnyServiceIpcContract> = Extract<MessageOf<Contract>, { type: 'heartbeat' }>;
type HeartbeatInput<Contract extends AnyServiceIpcContract> = Omit<HeartbeatOf<Contract>, 'service' | 'type'>;

export function createServiceIpcHeartbeatHelper<Contract extends AnyServiceIpcContract>(contract: Contract) {
    const builder = createServiceIpcMessageBuilder(contract);

    return {
        create(input: HeartbeatInput<Contract>): HeartbeatOf<Contract> {
            return builder.heartbeat(input);
        },
        parse(message: unknown): HeartbeatOf<Contract> {
            return contract.HeartbeatMessageSchema.parse(message) as HeartbeatOf<Contract>;
        },
        getAgeMs(params: Readonly<{ heartbeat: HeartbeatOf<Contract>; nowMs: number }>): number | null {
            if (!Number.isInteger(params.nowMs) || params.nowMs < params.heartbeat.sentAtMs) {
                return null;
            }

            return params.nowMs - params.heartbeat.sentAtMs;
        },
        isFresh(params: Readonly<{ heartbeat: HeartbeatOf<Contract>; nowMs: number; maxAgeMs: number }>): boolean {
            if (!Number.isInteger(params.maxAgeMs) || params.maxAgeMs < 0) {
                return false;
            }

            const ageMs = this.getAgeMs({ heartbeat: params.heartbeat, nowMs: params.nowMs });
            return ageMs !== null && ageMs <= params.maxAgeMs;
        },
    };
}
