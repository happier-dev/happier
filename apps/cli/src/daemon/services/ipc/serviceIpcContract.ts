import { z } from 'zod';

const ServiceIdentifierSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

export const SERVICE_IPC_MESSAGE_TYPES = ['heartbeat', 'config_update', 'status_update'] as const;

export type ServiceIpcMessageType = (typeof SERVICE_IPC_MESSAGE_TYPES)[number];

export type ServiceIpcHeartbeatMessage<ServiceName extends string> = Readonly<{
    service: ServiceName;
    type: 'heartbeat';
    sentAtMs: number;
    sequence: number;
}>;

export type ServiceIpcConfigUpdateMessage<ServiceName extends string, Config> = Readonly<{
    service: ServiceName;
    type: 'config_update';
    sentAtMs: number;
    sequence: number;
    configVersion: number;
    config: Config;
}>;

export type ServiceIpcStatusUpdateMessage<ServiceName extends string, Status> = Readonly<{
    service: ServiceName;
    type: 'status_update';
    sentAtMs: number;
    sequence: number;
    statusVersion: number;
    status: Status;
}>;

export type ServiceIpcMessage<ServiceName extends string, Config, Status> =
    | ServiceIpcHeartbeatMessage<ServiceName>
    | ServiceIpcConfigUpdateMessage<ServiceName, Config>
    | ServiceIpcStatusUpdateMessage<ServiceName, Status>;

export function createServiceIpcContract<
    const ServiceName extends string,
    ConfigSchema extends z.ZodType,
    StatusSchema extends z.ZodType,
>(params: Readonly<{
    service: ServiceName;
    configSchema: ConfigSchema;
    statusSchema: StatusSchema;
}>) {
    const scopedServiceSchema = ServiceIdentifierSchema.pipe(z.literal(params.service));
    const messageBaseSchema = z
        .object({
            service: scopedServiceSchema,
            sentAtMs: NonNegativeIntegerSchema,
            sequence: PositiveIntegerSchema,
        })
        .strict();

    const HeartbeatMessageSchema = messageBaseSchema.extend({
        type: z.literal('heartbeat'),
    });

    const ConfigUpdateMessageSchema = messageBaseSchema.extend({
        type: z.literal('config_update'),
        configVersion: NonNegativeIntegerSchema,
        config: params.configSchema,
    });

    const StatusUpdateMessageSchema = messageBaseSchema.extend({
        type: z.literal('status_update'),
        statusVersion: NonNegativeIntegerSchema,
        status: params.statusSchema,
    });

    return {
        service: params.service,
        HeartbeatMessageSchema,
        ConfigUpdateMessageSchema,
        StatusUpdateMessageSchema,
        ServiceMessageSchema: z.discriminatedUnion('type', [
            HeartbeatMessageSchema,
            ConfigUpdateMessageSchema,
            StatusUpdateMessageSchema,
        ]),
    };
}
