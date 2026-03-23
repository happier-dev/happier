import type { z } from 'zod';

import type {
    ServiceIpcConfigUpdateMessage,
    ServiceIpcHeartbeatMessage,
    ServiceIpcMessage,
    ServiceIpcStatusUpdateMessage,
} from './serviceIpcContract';

type AnyServiceIpcContract = Readonly<{
    service: string;
    HeartbeatMessageSchema: z.ZodType<ServiceIpcHeartbeatMessage<string>>;
    ConfigUpdateMessageSchema: z.ZodType<ServiceIpcConfigUpdateMessage<string, unknown>>;
    StatusUpdateMessageSchema: z.ZodType<ServiceIpcStatusUpdateMessage<string, unknown>>;
    ServiceMessageSchema: z.ZodType<ServiceIpcMessage<string, unknown, unknown>>;
}>;

type ServiceNameOf<Contract extends AnyServiceIpcContract> = Contract['service'];
type MessageOf<Contract extends AnyServiceIpcContract> = z.infer<Contract['ServiceMessageSchema']>;
type HeartbeatOf<Contract extends AnyServiceIpcContract> = Extract<MessageOf<Contract>, { type: 'heartbeat' }>;
type ConfigUpdateOf<Contract extends AnyServiceIpcContract> = Extract<MessageOf<Contract>, { type: 'config_update' }>;
type StatusUpdateOf<Contract extends AnyServiceIpcContract> = Extract<MessageOf<Contract>, { type: 'status_update' }>;

type HeartbeatInput<Contract extends AnyServiceIpcContract> = Omit<HeartbeatOf<Contract>, 'service' | 'type'>;
type ConfigUpdateInput<Contract extends AnyServiceIpcContract> = Omit<ConfigUpdateOf<Contract>, 'service' | 'type'>;
type StatusUpdateInput<Contract extends AnyServiceIpcContract> = Omit<StatusUpdateOf<Contract>, 'service' | 'type'>;

export function createServiceIpcMessageBuilder<Contract extends AnyServiceIpcContract>(contract: Contract) {
    return {
        heartbeat(input: HeartbeatInput<Contract>): HeartbeatOf<Contract> {
            return contract.HeartbeatMessageSchema.parse({
                service: contract.service as ServiceNameOf<Contract>,
                type: 'heartbeat',
                ...input,
            }) as HeartbeatOf<Contract>;
        },
        configUpdate(input: ConfigUpdateInput<Contract>): ConfigUpdateOf<Contract> {
            return contract.ConfigUpdateMessageSchema.parse({
                service: contract.service as ServiceNameOf<Contract>,
                type: 'config_update',
                ...input,
            }) as ConfigUpdateOf<Contract>;
        },
        statusUpdate(input: StatusUpdateInput<Contract>): StatusUpdateOf<Contract> {
            return contract.StatusUpdateMessageSchema.parse({
                service: contract.service as ServiceNameOf<Contract>,
                type: 'status_update',
                ...input,
            }) as StatusUpdateOf<Contract>;
        },
    };
}

export function encodeServiceIpcMessage<Contract extends AnyServiceIpcContract>(
    contract: Contract,
    message: MessageOf<Contract>,
): string {
    return JSON.stringify(contract.ServiceMessageSchema.parse(message));
}

export function decodeServiceIpcMessage<Contract extends AnyServiceIpcContract>(
    contract: Contract,
    encodedMessage: string,
): MessageOf<Contract> {
    return contract.ServiceMessageSchema.parse(JSON.parse(encodedMessage.trim())) as MessageOf<Contract>;
}
