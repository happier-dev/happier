import { z } from 'zod';
import { LocalServicePreviewInitialPathV1Schema } from '@happier-dev/protocol';

const NonEmptyStringSchema = z.string().trim().min(1).max(1_024);

export const HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY =
    'HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN';
export const HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY =
    'HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE';

const ExecLaunchInputV1Schema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('agent-cli'),
        agentId: NonEmptyStringSchema,
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        stdin: z.string().optional(),
    }).strict(),
    z.object({
        kind: z.literal('binary'),
        executablePath: NonEmptyStringSchema,
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        stdin: z.string().optional(),
    }).strict(),
    z.object({
        kind: z.literal('ipc'),
        endpoint: NonEmptyStringSchema,
    }).strict(),
]);

const LocalServiceDeclarationV1Schema = z.object({
    id: NonEmptyStringSchema.max(256),
    launch: ExecLaunchInputV1Schema,
    launchMode: z.discriminatedUnion('kind', [
        z.object({
            kind: z.literal('detectAfterLaunch'),
            minimumConfidence: z.enum(['high', 'medium', 'low']).optional(),
        }).strict(),
        z.object({
            kind: z.literal('assignAndInject'),
            portPolicy: z.discriminatedUnion('kind', [
                z.object({
                    kind: z.literal('fixed'),
                    port: z.number().int().min(1).max(65_535),
                    onCollision: z.enum(['fail', 'fallback']).optional(),
                }).strict(),
                z.object({
                    kind: z.literal('allocated'),
                    preferredPort: z.number().int().min(1).max(65_535).optional(),
                    onCollision: z.enum(['fail', 'fallback']).optional(),
                }).strict(),
                z.object({
                    kind: z.literal('inherited'),
                    envName: NonEmptyStringSchema,
                }).strict(),
            ]),
            environment: z.object({
                inject: z.array(NonEmptyStringSchema).optional(),
            }).strict().optional(),
        }).strict(),
        z.object({
            kind: z.literal('externalRegistered'),
            inventoryId: NonEmptyStringSchema,
            minimumConfidence: z.enum(['high', 'medium', 'low']).optional(),
        }).strict(),
    ]),
    hostPolicy: z.object({
        kind: z.literal('loopback'),
        host: z.string().optional(),
    }).strict(),
    name: z.discriminatedUnion('strategy', [
        z.object({
            strategy: z.literal('derived'),
            base: NonEmptyStringSchema,
        }).strict(),
        z.object({
            strategy: z.literal('fixed'),
            name: NonEmptyStringSchema,
        }).strict(),
    ]),
    healthCheck: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('none') }).strict(),
        z.object({
            kind: z.literal('http'),
            path: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
        }).strict(),
        z.object({
            kind: z.literal('command'),
            launch: ExecLaunchInputV1Schema,
            timeoutMs: z.number().int().positive().optional(),
        }).strict(),
    ]),
    restart: z.object({ kind: z.literal('never') }).strict(),
    cleanup: z.object({
        staleAfterMs: z.number().int().nonnegative(),
    }).strict(),
}).strict();

const LocalServiceRuntimeSnapshotV1Schema = z.object({
    id: NonEmptyStringSchema.max(256),
    phase: z.enum(['starting', 'detecting', 'running', 'unhealthy', 'stopping', 'stopped', 'failed']),
    inventoryId: z.string().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    url: z.string().optional(),
    diagnostics: z.array(z.object({
        code: z.string(),
        message: z.string().optional(),
        severity: z.enum(['info', 'warning', 'error']).optional(),
    }).strict()),
}).strict();

export const PluginLocalServicesBridgeControlContextV1Schema = z.object({
    pluginId: NonEmptyStringSchema.max(256),
    contributionId: NonEmptyStringSchema.max(256),
    sessionId: NonEmptyStringSchema.max(256),
    title: NonEmptyStringSchema.max(500),
    initialPath: LocalServicePreviewInitialPathV1Schema.optional(),
}).strict();

export const PluginLocalServicesBridgeControlRequestV1Schema = z.object({
    protocolVersion: z.literal(1),
    bridgeToken: NonEmptyStringSchema.max(256).optional(),
    context: PluginLocalServicesBridgeControlContextV1Schema,
    operation: z.discriminatedUnion('kind', [
        z.object({
            kind: z.literal('declare'),
            declaration: LocalServiceDeclarationV1Schema,
        }).strict(),
        z.object({
            kind: z.literal('start'),
            declaration: LocalServiceDeclarationV1Schema,
        }).strict(),
        z.object({
            kind: z.literal('get'),
            serviceId: NonEmptyStringSchema.max(256),
        }).strict(),
        z.object({
            kind: z.literal('stop'),
            serviceId: NonEmptyStringSchema.max(256),
        }).strict(),
    ]),
}).strict();

export type PluginLocalServicesBridgeControlRequestV1 = z.infer<typeof PluginLocalServicesBridgeControlRequestV1Schema>;

export const PluginLocalServicesBridgeControlResponseV1Schema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        snapshot: LocalServiceRuntimeSnapshotV1Schema.nullable().optional(),
    }).strict(),
    z.object({
        ok: z.literal(false),
        errorCode: NonEmptyStringSchema.max(256),
    }).strict(),
]);

export type PluginLocalServicesBridgeControlResponseV1 = z.infer<typeof PluginLocalServicesBridgeControlResponseV1Schema>;
