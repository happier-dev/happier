import { randomUUID } from 'node:crypto';

import { PluginError } from '@happier-dev/plugin-sdk';
import {
    ConnectedAccountMaterializationRequestSchema,
    ConnectedAccountPurposeIdSchema,
    ManagedExecutableRefSchema,
    ManagedServiceLocalIdSchema,
    PluginDiagnosticDataV1Schema,
    PluginIdSchema,
    PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
    ProviderRuntimeBindingBasisV1Schema,
    type AgentProviderBindingMaterializationV1,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type {
    ManagedDependenciesService,
    ManagedServiceErrorCode,
    ManagedServiceHandle,
    ManagedServiceRequest,
    ManagedServiceResponse,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import { z } from 'zod';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import type {
    ManagedProviderEndpointAccessProjection,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import {
    normalizeManagedServiceSpec,
    type NormalizedManagedServiceSpec,
} from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';
import type {
    RunnerManagedProviderRetainedAuthorityV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';
import type {
    RunnerDaemonManagedProviderRetentionV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import {
    MANAGED_SERVICE_ENDPOINT_READ_NEXT_RPC_TIMEOUT_MS,
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS,
    ManagedServiceEndpointReadCancelResultV1Schema,
    ManagedServiceEndpointReadNextResultV1Schema,
    ManagedServiceEndpointReadOpenRequestV1Schema,
    ManagedServiceEndpointReadOpenResultV1Schema,
    type ManagedServiceEndpointReadOpenRequestV1,
} from './managedServiceEndpointReadProtocol';

export type RunnerManagedProviderCustodyIdentityV1 = Readonly<{
    v: 1;
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    pluginId: string;
    providerLocalId: string;
    activationGeneration: string;
    immutableGenerationId: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    operationClaimId: string;
}>;

export type RunnerManagedProviderCustodyScopeV1 =
    RunnerManagedProviderCustodyIdentityV1;

export type RunnerManagedProviderCustodyClaimV1 =
    RunnerManagedProviderCustodyIdentityV1;

export type RunnerManagedProviderEndpointPathV1 = Readonly<{
    endpointTemplateId: string;
    servicePath: string;
}>;

export type RunnerManagedProviderAdoptedPublicOutcomeV1 = Readonly<{
    operationClaimId: string;
    serviceId: string;
    endpointTemplateIds: readonly string[];
    endpoints: readonly Readonly<
        RunnerManagedProviderEndpointPathV1 & { endpointUrl: string }
    >[];
    endpointAccess: 'runnerProjected';
}>;

type ManagedServiceMode = ManagedServiceSpec['mode'];
type SpawnManagedServiceMode = Extract<
    ManagedServiceMode,
    Readonly<{ kind: 'spawn' }>
>;
type AttachManagedServiceMode = Extract<
    ManagedServiceMode,
    Readonly<{ kind: 'attach' }>
>;
type SpawnManagedServiceSpec = Extract<
    ManagedServiceSpec,
    Readonly<{ mode: Readonly<{ kind: 'spawn' }> }>
>;
type AttachManagedServiceSpec = Extract<
    ManagedServiceSpec,
    Readonly<{ mode: Readonly<{ kind: 'attach' }> }>
>;
type ManagedServiceSpecBase = Pick<
    ManagedServiceSpec,
    | 'id'
    | 'credentialBindings'
    | 'healthCheck'
    | 'startupTimeoutMs'
    | 'healthPolicy'
>;

export type RunnerManagedServicesCustodyBytesV1 = Readonly<{
    t: 'bytes';
    base64: string;
}>;

export type RunnerManagedServiceSpecWireV1 =
    | Readonly<ManagedServiceSpecBase & {
        clientAccess?: SpawnManagedServiceSpec['clientAccess'];
        requestAuth?: Extract<
            ManagedServiceSpec,
            Readonly<{ mode: Readonly<{ kind: 'spawn' }> }>
        >['requestAuth'];
        mode: Readonly<Omit<SpawnManagedServiceMode, 'launch'> & {
            launch: Readonly<
                Omit<SpawnManagedServiceMode['launch'], 'stdin'>
                & { stdin?: RunnerManagedServicesCustodyBytesV1 }
            >;
        }>;
        durableLog?: Readonly<{ enabled: boolean; keepCount?: number }>;
    }>
    | Readonly<ManagedServiceSpecBase & {
        clientAccess?: AttachManagedServiceSpec['clientAccess'];
        mode: AttachManagedServiceMode;
        durableLog?: never;
    }>;

type AttachRunnerManagedServiceSpecWireV1 = Extract<
    RunnerManagedServiceSpecWireV1,
    Readonly<{ mode: Readonly<{ kind: 'attach' }> }>
>;

function isAttachManagedServiceSpec(
    spec: ManagedServiceSpec,
): spec is AttachManagedServiceSpec {
    return spec.mode.kind === 'attach';
}

function isAttachRunnerManagedServiceSpecWireV1(
    spec: RunnerManagedServiceSpecWireV1,
): spec is AttachRunnerManagedServiceSpecWireV1 {
    return spec.mode.kind === 'attach';
}

export type RunnerManagedServicesCustodyRequestV1 =
    | Readonly<{
        v: 1;
        kind: 'supervise';
        scope: RunnerManagedProviderCustodyScopeV1;
        spec: RunnerManagedServiceSpecWireV1;
    }>
    | Readonly<{
        v: 1;
        kind: 'adopt';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'projectEndpointAccess';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
        endpoints: readonly RunnerManagedProviderEndpointPathV1[];
    }>
    | Readonly<{
        v: 1;
        kind: 'commitAdoption';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'readAdoptedPublicOutcome';
        claim: RunnerManagedProviderCustodyClaimV1;
    }>
    | Readonly<{
        v: 1;
        kind: 'fenceHardRevocation';
        pluginId: string;
        immutableGenerationId?: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'fenceRetainedProviderPolicy';
        claim: RunnerManagedProviderCustodyClaimV1;
    }>
    | Readonly<{
        v: 1;
        kind: 'waitUntilHealthy';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
        timeoutMs?: number;
    }>
    | Readonly<{
        v: 1;
        kind: 'stop';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'dispose';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.open';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.next';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
        observationId: string;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.close';
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
        observationId: string;
    }>;

export type RunnerManagedServicesCustodyResultV1 =
    | Readonly<{
        v: 1;
        kind: 'handle';
        custodyScope: RunnerManagedProviderCustodyScopeV1;
        snapshot: ManagedServiceSnapshot;
    }>
    | Readonly<{
        v: 1;
        kind: 'stop';
        result: Readonly<{ status: 'stopped' | 'detached' }>;
        snapshot: ManagedServiceSnapshot;
    }>
    | Readonly<{
        v: 1;
        kind: 'disposed';
    }>
    | Readonly<{
        v: 1;
        kind: 'projected';
    }>
    | Readonly<{
        v: 1;
        kind: 'adopted';
    }>
    | Readonly<{
        v: 1;
        kind: 'adoptedPublicOutcome';
        outcome: RunnerManagedProviderAdoptedPublicOutcomeV1 | null;
    }>
    | Readonly<{
        v: 1;
        kind: 'hardRevocationFenced';
        fencedServiceCount: number;
    }>
    | Readonly<{
        v: 1;
        kind: 'retainedProviderPolicyFenced';
        fencedServiceCount: number;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.open';
        observationId: string;
        snapshot: ManagedServiceSnapshot;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.next';
        status: 'snapshot';
        snapshot: ManagedServiceSnapshot;
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.next';
        status: 'closed';
    }>
    | Readonly<{
        v: 1;
        kind: 'observe.close';
        closed: boolean;
    }>;

export type RunnerManagedServicesCustodyDispatchV1 = (
    request: RunnerManagedServicesCustodyRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<RunnerManagedServicesCustodyResultV1>;

export type RunnerManagedServicesCustodyPortV1 = Readonly<{
    dispatch: RunnerManagedServicesCustodyDispatchV1;
}>;

export type RunnerManagedServicesExactHandleRequestPortV1 = Readonly<{
    request(input: Readonly<{
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
        request: ManagedServiceRequest;
    }>): Promise<ManagedServiceResponse>;
    isCurrent(input: Readonly<{
        claim: RunnerManagedProviderCustodyClaimV1;
        serviceId: string;
    }>): Promise<boolean>;
}>;

export type RunnerManagedProviderAgentBindingMaterializationV1 =
    Readonly<{
        materialization: AgentProviderBindingMaterializationV1;
        redactionValues: readonly string[];
        transformLaunchEnvironment(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
    }>;

export type RunnerManagedServicesCustodyOwnerV1 =
    RunnerManagedServicesCustodyPortV1 & Readonly<{
        exactHandleRequestPort:
            RunnerManagedServicesExactHandleRequestPortV1;
        readCurrentManagedProviderRetention():
            Promise<RunnerDaemonManagedProviderRetentionV1 | null>;
        readAdoptedPublicOutcome():
            Promise<RunnerManagedProviderAdoptedPublicOutcomeV1 | null>;
        materializeAdoptedProviderAgentBinding(input: Readonly<{
            materialize(input: Readonly<{
                endpointUrl: string;
                credentialPlaceholder: string;
            }>): Promise<unknown>;
        }>): Promise<
            RunnerManagedProviderAgentBindingMaterializationV1
        >;
        dispose(): Promise<void>;
    }>;

export const RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD =
    'managedServices.custody.v1';

const BoundedProcessStringSchema = z.string()
    .max(65_536)
    .refine((value) => !value.includes('\0'));
const BoundedStringRecordSchema = z.record(
    z.string().min(1).max(256),
    BoundedProcessStringSchema,
).refine((value) => Object.keys(value).length <= 256);
const BoundedStringArraySchema = z.array(BoundedProcessStringSchema).max(512);
const PositiveTimeoutSchema = z.number().int().min(1).max(2_147_483_647);
const HostManagedServiceLocalIdSchema = asHostProtocolZod(
    ManagedServiceLocalIdSchema,
);
const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);
const CustodyIdentityPartSchema = z.string().min(1).max(1_024)
    .refine((value) => value === value.trim());
const ObservationIdSchema = z.string().uuid();
const EndpointPathSchema = z.object({
    endpointTemplateId: CustodyIdentityPartSchema,
    servicePath: z.string().min(1).max(16_384)
        .refine((value) => value.startsWith('/')),
}).strict();
const CanonicalBase64Schema = z.string().regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
).refine(
    (value) => Buffer.from(value, 'base64').toString('base64') === value,
    'Expected canonical padded Base64',
);
const CustodyBytesSchema = z.object({
    t: z.literal('bytes'),
    base64: CanonicalBase64Schema,
}).strict();

const CustodyIdentitySchema = z.object({
    v: z.literal(1),
    sessionId: CustodyIdentityPartSchema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
    pluginId: CustodyIdentityPartSchema,
    providerLocalId: CustodyIdentityPartSchema,
    activationGeneration: CustodyIdentityPartSchema,
    immutableGenerationId: CustodyIdentityPartSchema,
    manifestAuthority: z.enum(['external', 'bundled_first_party']),
    operationClaimId: CustodyIdentityPartSchema,
}).strict();

const PluginPathSchema = z.discriminatedUnion('root', [
    z.object({
        root: z.literal('pluginData'),
        relativePath: BoundedProcessStringSchema,
    }).strict(),
    z.object({
        root: z.literal('workspace'),
        relativePath: BoundedProcessStringSchema,
    }).strict(),
    z.object({
        root: z.literal('project'),
        projectId: CustodyIdentityPartSchema,
        relativePath: BoundedProcessStringSchema,
    }).strict(),
]);

const ExecSpawnRequestWireSchema = z.object({
    executable: ManagedExecutableRefSchema,
    args: BoundedStringArraySchema.optional(),
    cwd: PluginPathSchema.optional(),
    env: BoundedStringRecordSchema.optional(),
    stdin: CustodyBytesSchema.optional(),
    maxStdoutBytes: z.number().int().min(0).max(1_073_741_824).optional(),
    maxStderrBytes: z.number().int().min(0).max(1_073_741_824).optional(),
}).strict();

const MaterializationInjectionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('environment'),
        targetEnvironmentKeysByMaterializedKey:
            BoundedStringRecordSchema,
    }).strict(),
    z.object({
        kind: z.literal('httpHeaders'),
        target: z.enum([
            'healthRequests',
            'providerRequests',
            'healthAndProviderRequests',
        ]),
    }).strict(),
    z.object({
        kind: z.literal('files'),
        pathsByFileId: z.record(
            z.string().min(1).max(256),
            z.object({
                environmentKey: z.string().min(1).max(256),
            }).strict(),
        ).refine((value) => Object.keys(value).length <= 128),
    }).strict(),
]);
const CredentialBindingSchema = z.object({
    purpose: ConnectedAccountPurposeIdSchema,
    request: ConnectedAccountMaterializationRequestSchema,
    injection: MaterializationInjectionSchema,
}).strict();
const HealthCheckSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
        kind: z.literal('http'),
        target: z.object({
            kind: z.literal('servicePath'),
            path: z.string().min(1).max(16_384),
        }).strict().optional(),
        headers: BoundedStringRecordSchema.optional(),
        timeoutMs: PositiveTimeoutSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('command'),
        executable: ManagedExecutableRefSchema,
        args: BoundedStringArraySchema.optional(),
        timeoutMs: PositiveTimeoutSchema.optional(),
    }).strict(),
]);
const ClientAccessSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
        kind: z.literal('hostBearer'),
        injectEnvironmentKey: z.string().min(1).max(256),
        headerName: z.string().min(1).max(256),
        scheme: z.literal('Bearer'),
    }).strict(),
    z.object({
        kind: z.literal('hostBasic'),
        username: z.string().min(1).max(256),
        injectPasswordEnvironmentKey: z.string().min(1).max(256),
    }).strict(),
]);
const ManagedServiceSpecBaseShape = {
    id: HostManagedServiceLocalIdSchema,
    credentialBindings: z.array(CredentialBindingSchema).optional(),
    healthCheck: HealthCheckSchema.optional(),
    startupTimeoutMs: PositiveTimeoutSchema.optional(),
    healthPolicy: z.object({
        intervalMs: PositiveTimeoutSchema,
        consecutiveFailures: z.number().int().min(1).max(1_000_000),
    }).strict().optional(),
};
const ManagedServiceSpecWireSchema = z.union([
    z.object({
        ...ManagedServiceSpecBaseShape,
        clientAccess: ClientAccessSchema.optional(),
        requestAuth: z.object({
            kind: z.literal('connectedAccountCapabilityPath'),
            injectEnvironmentKey: z.string().min(1).max(256),
        }).strict().optional(),
        mode: z.object({
            kind: z.literal('spawn'),
            launch: ExecSpawnRequestWireSchema,
            endpoint: z.discriminatedUnion('kind', [
                z.object({
                    kind: z.literal('detectAfterLaunch'),
                    minimumConfidence: z.enum(['high', 'medium', 'low'])
                        .optional(),
                }).strict(),
                z.object({
                    kind: z.literal('assignAndInject'),
                    host: z.enum(['127.0.0.1', '::1']).optional(),
                    port: z.discriminatedUnion('kind', [
                        z.object({
                            kind: z.literal('fixed'),
                            port: z.number().int().min(1).max(65_535),
                            onCollision: z.enum(['fail', 'fallback'])
                                .optional(),
                        }).strict(),
                        z.object({
                            kind: z.literal('allocated'),
                            preferredPort: z.number().int().min(1)
                                .max(65_535).optional(),
                            onCollision: z.enum(['fail', 'fallback'])
                                .optional(),
                        }).strict(),
                    ]),
                    inject: z.object({
                        argument: BoundedProcessStringSchema.optional(),
                        portEnvironmentKey: z.string().min(1).max(256)
                            .optional(),
                        baseUrlEnvironmentKey: z.string().min(1).max(256)
                            .optional(),
                    }).strict().optional(),
                }).strict(),
            ]),
        }).strict(),
        durableLog: z.object({
            enabled: z.boolean(),
            keepCount: z.number().int().min(0).max(1_000_000).optional(),
        }).strict().optional(),
    }).strict(),
    z.object({
        ...ManagedServiceSpecBaseShape,
        clientAccess: z.object({ kind: z.literal('none') }).strict().optional(),
        mode: z.object({
            kind: z.literal('attach'),
            baseUrl: z.string().url().max(16_384),
        }).strict(),
    }).strict(),
]);

export const RunnerManagedServicesCustodyRequestV1Schema =
    z.discriminatedUnion('kind', [
        z.object({
            v: z.literal(1),
            kind: z.literal('supervise'),
            scope: CustodyIdentitySchema,
            spec: ManagedServiceSpecWireSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('adopt'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('projectEndpointAccess'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
            endpoints: z.array(EndpointPathSchema).min(1)
                .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('commitAdoption'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('readAdoptedPublicOutcome'),
            claim: CustodyIdentitySchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('fenceHardRevocation'),
            pluginId: HostPluginIdSchema,
            immutableGenerationId:
                CustodyIdentityPartSchema.optional(),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('fenceRetainedProviderPolicy'),
            claim: CustodyIdentitySchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('waitUntilHealthy'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
            timeoutMs: PositiveTimeoutSchema.optional(),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('stop'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('dispose'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.open'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.next'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
            observationId: ObservationIdSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.close'),
            claim: CustodyIdentitySchema,
            serviceId: HostManagedServiceLocalIdSchema,
            observationId: ObservationIdSchema,
        }).strict(),
    ]);

const ManagedServiceSnapshotSchema: z.ZodType<ManagedServiceSnapshot> =
    z.object({
        id: HostManagedServiceLocalIdSchema,
        state: z.enum([
            'starting',
            'detecting',
            'healthy',
            'unhealthy',
            'stopping',
            'stopped',
            'failed',
        ]),
        mode: z.enum(['spawn', 'attach']),
        baseUrl: z.string().url().max(16_384).nullable(),
        startedAtMs: z.number().finite().nonnegative().nullable(),
        lastHealthyAtMs: z.number().finite().nonnegative().nullable(),
        diagnostics: z.array(PluginDiagnosticDataV1Schema).max(1_024),
        diagnosticsTruncated: z.boolean(),
    }).strict();

const AdoptedPublicOutcomeSchema:
    z.ZodType<RunnerManagedProviderAdoptedPublicOutcomeV1> = z.object({
        operationClaimId: CustodyIdentityPartSchema,
        serviceId: HostManagedServiceLocalIdSchema,
        endpointTemplateIds: z.array(CustodyIdentityPartSchema)
            .min(1)
            .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)
            .refine((values) => new Set(values).size === values.length),
        endpoints: z.array(EndpointPathSchema.extend({
            endpointUrl: z.string().url().max(16_384),
        }).strict()).min(1)
            .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
        endpointAccess: z.literal('runnerProjected'),
    }).strict().superRefine((value, context) => {
        if (
            value.endpointTemplateIds.length !== value.endpoints.length
            || value.endpointTemplateIds.some(
                (id, index) => id
                    !== value.endpoints[index]?.endpointTemplateId,
            )
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'Managed Provider endpoint ids must match ordered endpoint rows',
            });
        }
    });

export const RunnerManagedServicesCustodyResultV1Schema:
    z.ZodType<RunnerManagedServicesCustodyResultV1> =
    z.union([
        z.object({
            v: z.literal(1),
            kind: z.literal('handle'),
            custodyScope: CustodyIdentitySchema,
            snapshot: ManagedServiceSnapshotSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('stop'),
            result: z.object({
                status: z.enum(['stopped', 'detached']),
            }).strict(),
            snapshot: ManagedServiceSnapshotSchema,
        }).strict(),
        z.object({ v: z.literal(1), kind: z.literal('disposed') })
            .strict(),
        z.object({ v: z.literal(1), kind: z.literal('projected') })
            .strict(),
        z.object({ v: z.literal(1), kind: z.literal('adopted') })
            .strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('adoptedPublicOutcome'),
            outcome: AdoptedPublicOutcomeSchema.nullable(),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('hardRevocationFenced'),
            fencedServiceCount: z.number().int().min(0),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('retainedProviderPolicyFenced'),
            fencedServiceCount: z.number().int().min(0),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.open'),
            observationId: ObservationIdSchema,
            snapshot: ManagedServiceSnapshotSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.next'),
            status: z.literal('snapshot'),
            snapshot: ManagedServiceSnapshotSchema,
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.next'),
            status: z.literal('closed'),
        }).strict(),
        z.object({
            v: z.literal(1),
            kind: z.literal('observe.close'),
            closed: z.boolean(),
        }).strict(),
    ]);

type CustodyEntry = Readonly<{
    scope: RunnerManagedProviderCustodyScopeV1;
    providerPluginHardRevocationRevisionAtAdmission: number;
    handle: ManagedServiceHandle;
    disposal: {
        handles: ManagedServiceHandle[];
        activeRequests: Set<AbortController>;
        started: boolean;
        projectionCleanupComplete: boolean;
        promise: Promise<void> | null;
        failure: Readonly<{ reason: unknown }> | null;
    };
    lifecycle: {
        adopted: boolean;
        authorityRetained: boolean;
        projection: Readonly<{
            endpoints: readonly RunnerManagedProviderEndpointPathV1[];
            owner: ManagedProviderEndpointAccessProjection;
        }> | null;
    };
}>;

type CustodyEstablishment = {
    scope: RunnerManagedProviderCustodyScopeV1;
    spec: NormalizedManagedServiceSpec;
    promise: Promise<CustodyEntry>;
    controller: AbortController;
    revisionAtAdmission: number | null;
    waiters: number;
    settled: boolean;
    abandoned: boolean;
    cleanupFailureRetained: boolean;
};

type CustodyObservation = {
    id: string;
    entryKey: string;
    subscription: Readonly<{ dispose(): void }>;
    queuedSnapshot: ManagedServiceSnapshot | null;
    wakePendingNext: (() => void) | null;
    closed: boolean;
};


function fail(code: ManagedServiceErrorCode, message: string): never {
    throw new PluginError({ code, message });
}

function runnerManagedServiceCleanupAggregate(
    failures: readonly unknown[],
    message: string,
): AggregateError & Readonly<{ code: ManagedServiceErrorCode }> {
    const sanitized: PluginError[] = [];
    const append = (failure: unknown): void => {
        if (failure instanceof AggregateError) {
            for (const nested of failure.errors) append(nested);
            return;
        }
        sanitized.push(new PluginError({
            code: 'plugin_managed_service_establishment_failed',
            message: 'Runner managed-service cleanup failed',
        }));
    };
    for (const failure of failures) append(failure);
    const code: ManagedServiceErrorCode =
        'plugin_managed_service_establishment_failed';
    return Object.assign(new AggregateError(sanitized, message), {
        code,
    });
}

function normalizedIdentityPart(value: string, name: string): string {
    const normalized = value.trim();
    if (
        normalized.length === 0
        || normalized.length > 1_024
        || normalized !== value
    ) {
        return fail(
            'plugin_managed_service_unavailable',
            `Managed Provider custody ${name} is invalid`,
        );
    }
    return normalized;
}

function normalizeManagedRuntimeBindingBasis(
    value: ProviderRuntimeBindingBasisV1,
): ProviderRuntimeBindingBasisV1 {
    const parsed = ProviderRuntimeBindingBasisV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.deployment.kind !== 'managedLocal') {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed Provider custody requires a managed-local runtime binding basis',
        );
    }
    return parsed.data;
}

function normalizeCustodyIdentity(
    value: RunnerManagedProviderCustodyIdentityV1,
): RunnerManagedProviderCustodyIdentityV1 {
    if (value.v !== 1) {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed Provider custody version is invalid',
        );
    }
    const runtimeBindingBasis = normalizeManagedRuntimeBindingBasis(
        value.runtimeBindingBasis,
    );
    if (runtimeBindingBasis.deployment.kind !== 'managedLocal') return fail(
        'plugin_managed_service_unavailable',
        'Managed Provider custody requires a managed-local runtime binding basis',
    );
    const scope = Object.freeze({
        v: 1,
        sessionId: normalizedIdentityPart(
            value.sessionId,
            'session identity',
        ),
        runtimeBindingBasis,
        pluginId: normalizedIdentityPart(
            value.pluginId,
            'plugin identity',
        ),
        providerLocalId: normalizedIdentityPart(
            value.providerLocalId,
            'Provider identity',
        ),
        activationGeneration: normalizedIdentityPart(
            value.activationGeneration,
            'activation generation',
        ),
        immutableGenerationId: normalizedIdentityPart(
            value.immutableGenerationId,
            'immutable generation',
        ),
        manifestAuthority: value.manifestAuthority === 'external'
            || value.manifestAuthority === 'bundled_first_party'
            ? value.manifestAuthority
            : fail(
                'plugin_managed_service_unavailable',
                'Managed Provider custody manifest authority is invalid',
            ),
        operationClaimId: normalizedIdentityPart(
            value.operationClaimId,
            'operation claim',
        ),
    });
    if (
        scope.pluginId
            !== runtimeBindingBasis.deployment
                .implementationIdentity.pluginId
        || scope.providerLocalId
            !== runtimeBindingBasis.deployment
                .implementationIdentity.localId
    ) {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed Provider custody identity conflicts with its runtime binding basis',
        );
    }
    return scope;
}

const normalizeScope = normalizeCustodyIdentity;
const normalizeClaim = normalizeCustodyIdentity;

function stableJson(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`;
}

export function isExactRunnerManagedProviderCustodyScope(
    left: RunnerManagedProviderCustodyScopeV1,
    right: RunnerManagedProviderCustodyScopeV1,
): boolean {
    try {
        return stableJson(normalizeScope(left))
            === stableJson(normalizeScope(right));
    } catch {
        return false;
    }
}

function encodeCustodyBytes(
    value: Uint8Array,
): RunnerManagedServicesCustodyBytesV1 {
    return Object.freeze({
        t: 'bytes',
        base64: Buffer.from(value).toString('base64'),
    });
}

function decodeCustodyBytes(
    value: RunnerManagedServicesCustodyBytesV1,
): Uint8Array {
    return new Uint8Array(Buffer.from(value.base64, 'base64'));
}

export function encodeRunnerManagedServiceSpecWireV1(
    spec: ManagedServiceSpec,
): RunnerManagedServiceSpecWireV1 {
    const normalizedSpec = normalizeManagedServiceSpec(spec);
    if (isAttachManagedServiceSpec(normalizedSpec)) {
        const {
            mode: _mode,
            durableLog: _durableLog,
            ...base
        } = normalizedSpec;
        return Object.freeze({
            ...base,
            mode: Object.freeze({
                kind: 'attach' as const,
                baseUrl: normalizedSpec.mode.baseUrl,
            }),
        });
    }
    const { stdin, ...launch } = normalizedSpec.mode.launch;
    return Object.freeze({
        ...normalizedSpec,
        mode: Object.freeze({
            ...normalizedSpec.mode,
            launch: Object.freeze({
                ...launch,
                ...(stdin !== undefined
                    ? { stdin: encodeCustodyBytes(stdin) }
                    : {}),
            }),
        }),
    });
}

function decodeRunnerManagedServiceSpecWireV1(
    spec: RunnerManagedServiceSpecWireV1,
): ManagedServiceSpec {
    if (isAttachRunnerManagedServiceSpecWireV1(spec)) {
        const {
            mode: _mode,
            durableLog: _durableLog,
            ...base
        } = spec;
        return Object.freeze({
            ...base,
            mode: Object.freeze({
                kind: 'attach' as const,
                baseUrl: spec.mode.baseUrl,
            }),
        });
    }
    const { stdin, ...launch } = spec.mode.launch;
    return Object.freeze({
        ...spec,
        mode: Object.freeze({
            ...spec.mode,
            launch: Object.freeze({
                ...launch,
                ...(stdin !== undefined
                    ? { stdin: decodeCustodyBytes(stdin) }
                    : {}),
            }),
        }),
    });
}

function claimFromScope(
    scope: RunnerManagedProviderCustodyScopeV1,
): RunnerManagedProviderCustodyClaimV1 {
    return normalizeCustodyIdentity(scope);
}

function claimKey(claim: RunnerManagedProviderCustodyClaimV1): string {
    return stableJson(claim);
}

function entryKey(
    claim: RunnerManagedProviderCustodyClaimV1,
    serviceId: string,
): string {
    return `${claimKey(claim)}\0${serviceId}`;
}

function requireHardRevocationRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail(
            'plugin_managed_service_unavailable',
            'Managed Provider hard-revocation revision is invalid',
        );
    }
    return value;
}

function requireServiceId(value: string): string {
    const parsed = ManagedServiceLocalIdSchema.safeParse(value);
    if (!parsed.success) {
        return fail(
            'plugin_managed_service_spec_invalid',
            'Managed service id is invalid',
        );
    }
    return parsed.data;
}

function cloneSnapshot(
    snapshot: ManagedServiceSnapshot,
): ManagedServiceSnapshot {
    return Object.freeze({
        ...snapshot,
        diagnostics: Object.freeze([
            ...snapshot.diagnostics,
        ]),
    });
}

function requireOperationActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
        return fail(
            'plugin_operation_aborted',
            'Managed service operation was aborted',
        );
    }
}

async function waitForCustodyEstablishment(
    establishment: CustodyEstablishment,
    signal?: AbortSignal,
): Promise<CustodyEntry> {
    if (signal?.aborted) {
        return fail(
            'plugin_operation_aborted',
            'Managed service operation was aborted',
        );
    }
    establishment.waiters += 1;
    try {
        if (!signal) return await establishment.promise;
        return await new Promise<CustodyEntry>((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(new PluginError({
                    code: 'plugin_operation_aborted',
                    message: 'Managed service operation was aborted',
                }));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            establishment.promise.then(
                (entry) => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(entry);
                },
                (error: unknown) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            );
            if (signal.aborted) onAbort();
        });
    } finally {
        establishment.waiters -= 1;
        if (
            establishment.waiters === 0
            && !establishment.settled
        ) {
            establishment.abandoned = true;
            establishment.controller.abort();
        }
    }
}

export function createRunnerManagedServicesCustodyPort(input: Readonly<{
    resolveAuthorizedServicesForSupervise(
        scope: RunnerManagedProviderCustodyScopeV1,
    ):
        | Readonly<{
            services: ManagedServices;
            providerPluginHardRevocationRevisionAtAdmission: number;
        }>
        | null
        | Promise<Readonly<{
            services: ManagedServices;
            providerPluginHardRevocationRevisionAtAdmission: number;
        }> | null>;
    readCurrentProviderPluginHardRevocationRevision(
        pluginId: string,
    ): number | Promise<number>;
    readCurrentProviderImmutableGenerationIntegrityCurrentness(
        authority: Readonly<{
            pluginId: string;
            immutableGenerationId: string;
            manifestAuthority: 'external' | 'bundled_first_party';
        }>,
    ): boolean | Promise<boolean>;
    projectEndpointAccess?(input: Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        service: ManagedServiceHandle;
        endpoints: readonly RunnerManagedProviderEndpointPathV1[];
        signal?: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null>;
    materializeAgentBinding?(input: Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        service: ManagedServiceHandle;
        projection: ManagedProviderEndpointAccessProjection;
        endpointTemplateId: string;
        materialize(input: Readonly<{
            endpointUrl: string;
            credentialPlaceholder: string;
        }>): Promise<unknown>;
    }>): Promise<
        RunnerManagedProviderAgentBindingMaterializationV1 | null
    >;
    retainAdoptedProviderAuthority?(
        authority: RunnerManagedProviderRetainedAuthorityV1,
    ): boolean | Promise<boolean>;
    releaseAdoptedProviderAuthority?(
        authority: RunnerManagedProviderRetainedAuthorityV1,
    ): boolean | Promise<boolean>;
}>): RunnerManagedServicesCustodyOwnerV1 {
    // This is the transport projection of the real runner-owned handles. It
    // makes no lifecycle or Provider-policy decisions: SVC09 remains the
    // lifecycle owner, and only a daemon-admitted new Q supervise may supply
    // services above. Exact adopted P observation and cleanup stay local to
    // its already-admitted runner custody and never reconstruct through Q.
    const entries = new Map<string, CustodyEntry>();
    const establishments = new Map<string, CustodyEstablishment>();
    const observations = new Map<string, CustodyObservation>();
    let closed = false;
    let cleanupPromise: Promise<void> | null = null;
    let adoptionCommitTail: Promise<void> = Promise.resolve();
    let activeManagedProviderRetentionReads = 0;

    const withAdoptionCommitFence = async <T>(
        operation: () => Promise<T>,
    ): Promise<T> => {
        const predecessor = adoptionCommitTail;
        let release!: () => void;
        adoptionCommitTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await predecessor;
        try {
            return await operation();
        } finally {
            release();
        }
    };

    const requireEntry = (
        claim: RunnerManagedProviderCustodyClaimV1,
        serviceId: string,
    ): CustodyEntry => entries.get(entryKey(claim, serviceId))
        ?? fail(
            'plugin_managed_service_unavailable',
            'Exact adopted managed Provider service is unavailable',
        );

    const requireAuthorityCurrent = async (
        scope: RunnerManagedProviderCustodyScopeV1,
        revisionAtAdmission: number,
    ): Promise<void> => {
        let currentRevision: number;
        try {
            currentRevision = requireHardRevocationRevision(
                await input.readCurrentProviderPluginHardRevocationRevision(
                    scope.pluginId,
                ),
            );
        } catch {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider hard-revocation currentness is unavailable',
            );
        }
        if (currentRevision !== revisionAtAdmission) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider custody was hard-revoked',
            );
        }
        if (
            await input
                .readCurrentProviderImmutableGenerationIntegrityCurrentness(
                    {
                        pluginId: scope.pluginId,
                        immutableGenerationId:
                            scope.immutableGenerationId,
                        manifestAuthority: scope.manifestAuthority,
                    },
                ) !== true
        ) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider custody was hard-revoked',
            );
        }
        try {
            currentRevision = requireHardRevocationRevision(
                await input.readCurrentProviderPluginHardRevocationRevision(
                    scope.pluginId,
                ),
            );
        } catch {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider hard-revocation currentness is unavailable',
            );
        }
        if (currentRevision !== revisionAtAdmission) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider custody was hard-revoked',
            );
        }
    };
    const requireEntryExposable = async (
        entry: CustodyEntry,
    ): Promise<void> => await requireAuthorityCurrent(
        entry.scope,
        entry.providerPluginHardRevocationRevisionAtAdmission,
    );
    const retainedAuthority = (
        entry: CustodyEntry,
    ): RunnerManagedProviderRetainedAuthorityV1 => Object.freeze({
        pluginId: entry.scope.pluginId,
        immutableGenerationId: entry.scope.immutableGenerationId,
        manifestAuthority: entry.scope.manifestAuthority,
        hardRevocationRevisionAtAdmission:
            entry.providerPluginHardRevocationRevisionAtAdmission,
    });
    const requireCustodyActive = (): void => {
        if (closed) {
            return fail(
                'plugin_managed_service_unavailable',
                'Runner managed-services custody has ended',
            );
        }
    };

    const closeObservation = (
        observation: CustodyObservation,
    ): boolean => {
        if (observation.closed) return false;
        observation.closed = true;
        observations.delete(observation.id);
        try {
            observation.subscription.dispose();
        } catch {
            // Observation cleanup cannot prevent authoritative handle cleanup.
        }
        observation.wakePendingNext?.();
        observation.wakePendingNext = null;
        observation.queuedSnapshot = null;
        return true;
    };
    const closeObservationsForEntry = (key: string): void => {
        for (const observation of observations.values()) {
            if (observation.entryKey === key) {
                closeObservation(observation);
            }
        }
    };
    const requireObservation = (
        observationId: string,
        key: string,
    ): CustodyObservation => {
        const observation = observations.get(observationId);
        if (!observation || observation.entryKey !== key) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider custody observation is unavailable',
            );
        }
        return observation;
    };
    const abortEntryRequests = (
        entry: CustodyEntry,
        reason: string,
    ): void => {
        for (const controller of entry.disposal.activeRequests) {
            controller.abort(reason);
        }
        entry.disposal.activeRequests.clear();
    };
    const disposeEntry = async (
        entry: CustodyEntry,
        retryFailure = true,
    ): Promise<void> => {
        abortEntryRequests(
            entry,
            'Exact managed-service custody is being disposed',
        );
        if (entry.disposal.promise) {
            await entry.disposal.promise;
            return;
        }
        if (!retryFailure && entry.disposal.failure) {
            throw entry.disposal.failure.reason;
        }
        if (retryFailure) entry.disposal.failure = null;
        entry.disposal.started = true;
        const attempt = (async () => {
            const cleanups: Array<() => Promise<void>> = [];
            if (
                entry.lifecycle.projection
                && !entry.disposal.projectionCleanupComplete
            ) {
                cleanups.push(async () => {
                    await entry.lifecycle.projection!.owner.cleanup();
                    entry.disposal.projectionCleanupComplete = true;
                });
            }
            for (const handle of [...entry.disposal.handles]) {
                cleanups.push(async () => {
                    await handle.dispose();
                    const index = entry.disposal.handles.indexOf(handle);
                    if (index >= 0) entry.disposal.handles.splice(index, 1);
                });
            }
            const outcomes = await Promise.allSettled(
                cleanups.map(async (cleanup) => await cleanup()),
            );
            const cleanupFailures = outcomes.flatMap((outcome) =>
                outcome.status === 'rejected'
                    ? [outcome.reason]
                    : []);
            if (cleanupFailures.length > 0) {
                throw runnerManagedServiceCleanupAggregate(
                    cleanupFailures,
                    'Failed to clean runner managed-service entry',
                );
            }
            if (entry.lifecycle.authorityRetained) {
                const [releaseOutcome] = await Promise.allSettled([
                    (async () => {
                        if (
                            !input.releaseAdoptedProviderAuthority
                            || !await input.releaseAdoptedProviderAuthority(
                                retainedAuthority(entry),
                            )
                        ) {
                            return fail(
                                'plugin_managed_service_unavailable',
                                'Runner managed Provider generation pin could not be released',
                            );
                        }
                        entry.lifecycle.authorityRetained = false;
                    })(),
                ]);
                if (releaseOutcome?.status === 'rejected') {
                    throw releaseOutcome.reason;
                }
            }
        })();
        entry.disposal.promise = attempt;
        try {
            await attempt;
            entry.disposal.failure = null;
        } catch (error) {
            entry.disposal.failure = Object.freeze({ reason: error });
            throw error;
        } finally {
            if (entry.disposal.promise === attempt) {
                entry.disposal.promise = null;
            }
        }
    };
    const retainEntryHandle = async (
        key: string,
        entry: CustodyEntry,
        handle: ManagedServiceHandle,
    ): Promise<boolean> => {
        if (entry.disposal.handles.includes(handle)) {
            return !entry.disposal.started;
        }
        entry.disposal.handles.push(handle);
        if (!entry.disposal.started) return true;
        if (entries.get(key) !== entry) entries.set(key, entry);
        await disposeEntry(entry, false);
        if (entry.disposal.handles.includes(handle)) {
            await disposeEntry(entry, false);
        }
        return false;
    };

    const settleAbandonedEstablishments = async (
        ownedEstablishments: readonly (readonly [
            string,
            CustodyEstablishment,
        ])[],
    ): Promise<Readonly<{
        failures: readonly unknown[];
        retainedEntryKeys: ReadonlySet<string>;
    }>> => {
        const outcomes = await Promise.allSettled(
            ownedEstablishments.map(([, establishment]) =>
                establishment.promise),
        );
        const failures: unknown[] = [];
        const retainedEntryKeys = new Set<string>();
        for (const [index, outcome] of outcomes.entries()) {
            const key = ownedEstablishments[index]?.[0];
            if (
                key
                && outcome.status === 'rejected'
                && ownedEstablishments[index]?.[1]
                    .cleanupFailureRetained
                && entries.has(key)
            ) {
                failures.push(outcome.reason);
                retainedEntryKeys.add(key);
            }
        }
        return Object.freeze({ failures, retainedEntryKeys });
    };

    const fenceOwnedServices = async (input: Readonly<{
        establishments: readonly (readonly [
            string,
            CustodyEstablishment,
        ])[];
        entries: readonly (readonly [string, CustodyEntry])[];
        abortReason: string;
        cleanupFailureMessage: string;
    }>): Promise<number> => {
        for (const [, establishment] of input.establishments) {
            establishment.abandoned = true;
            establishment.controller.abort(input.abortReason);
        }
        for (const [key] of input.entries) {
            closeObservationsForEntry(key);
        }
        const establishmentCleanup =
            await settleAbandonedEstablishments(input.establishments);
        const entryOutcomes = await Promise.allSettled(
            input.entries
                .filter(([key, entry]) => (
                    !establishmentCleanup.retainedEntryKeys.has(key)
                    && entries.get(key) === entry
                ))
                .map(async ([key, entry]) => {
                    await disposeEntry(entry);
                    if (entries.get(key) === entry) entries.delete(key);
                }),
        );
        const failures = [
            ...establishmentCleanup.failures,
            ...entryOutcomes.flatMap((outcome) =>
                outcome.status === 'rejected'
                    ? [outcome.reason]
                    : []),
        ];
        if (failures.length > 0) {
            throw runnerManagedServiceCleanupAggregate(
                failures,
                input.cleanupFailureMessage,
            );
        }
        return input.entries.length + input.establishments.length;
    };

    const dispatch: RunnerManagedServicesCustodyDispatchV1 = async (
        request,
        options,
    ) => {
        const serviceId = request.kind === 'readAdoptedPublicOutcome'
            || request.kind === 'fenceHardRevocation'
            || request.kind === 'fenceRetainedProviderPolicy'
            ? null
            : requireServiceId(
                request.kind === 'supervise'
                    ? request.spec.id
                    : request.serviceId,
            );
        requireOperationActive(options?.signal);
        if (closed) {
            return fail(
                'plugin_managed_service_unavailable',
                'Runner managed-services custody has ended',
            );
        }
        if (request.kind === 'fenceHardRevocation') {
            const currentRevision = requireHardRevocationRevision(
                await input.readCurrentProviderPluginHardRevocationRevision(
                    request.pluginId,
                ),
            );
            const fencedEstablishments = [...establishments.entries()]
                .filter(([, establishment]) => (
                    establishment.scope.pluginId === request.pluginId
                    && (request.immutableGenerationId
                        ? establishment.scope.immutableGenerationId
                            === request.immutableGenerationId
                        : establishment.revisionAtAdmission
                            !== currentRevision)
                ));
            const fencedEntries = [...entries.entries()].filter(
                ([, entry]) => (
                    entry.scope.pluginId === request.pluginId
                    && (request.immutableGenerationId
                        ? entry.scope.immutableGenerationId
                            === request.immutableGenerationId
                        : entry
                            .providerPluginHardRevocationRevisionAtAdmission
                            !== currentRevision)
                ),
            );
            const fencedServiceCount = await fenceOwnedServices({
                establishments: fencedEstablishments,
                entries: fencedEntries,
                abortReason:
                    'Managed Provider hard-revocation fenced establishment',
                cleanupFailureMessage:
                    'Failed to fence hard-revoked runner managed services',
            });
            return Object.freeze({
                v: 1,
                kind: 'hardRevocationFenced',
                fencedServiceCount,
            });
        }
        if (request.kind === 'fenceRetainedProviderPolicy') {
            const claim = normalizeClaim(request.claim);
            const exactClaimKey = claimKey(claim);
            const fencedEstablishments = [...establishments.entries()]
                .filter(([, establishment]) =>
                    claimKey(claimFromScope(establishment.scope))
                        === exactClaimKey);
            const fencedEntries = [...entries.entries()]
                .filter(([, entry]) =>
                    claimKey(claimFromScope(entry.scope))
                        === exactClaimKey);
            const fencedServiceCount = await fenceOwnedServices({
                establishments: fencedEstablishments,
                entries: fencedEntries,
                abortReason:
                    'Managed Provider live-policy revocation fenced establishment',
                cleanupFailureMessage:
                    'Failed to fence live-policy-revoked runner managed services',
            });
            return Object.freeze({
                v: 1,
                kind: 'retainedProviderPolicyFenced',
                fencedServiceCount,
            });
        }
        if (request.kind === 'supervise') {
            if (serviceId === null) {
                return fail(
                    'plugin_managed_service_spec_invalid',
                    'Managed service id is unavailable',
                );
            }
            const spec = normalizeManagedServiceSpec(
                decodeRunnerManagedServiceSpecWireV1(request.spec),
            );
            const scope = normalizeScope(request.scope);
            const claim = claimFromScope(scope);
            const key = entryKey(claim, serviceId);
            const exactScopeKey = stableJson(scope);
            const belongsToAnotherExactScope =
                [...entries.values()].some((entry) =>
                    entry.handle.snapshot().id === serviceId
                    && claimKey(claimFromScope(entry.scope))
                        !== claimKey(claim))
                || [...establishments.values()].some((establishment) =>
                    establishment.spec.id === serviceId
                    && claimKey(claimFromScope(establishment.scope))
                        !== claimKey(claim));
            if (belongsToAnotherExactScope) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed service belongs to another exact Provider custody scope',
                );
            }
            const existing = entries.get(key);
            if (
                activeManagedProviderRetentionReads > 0
                && existing?.lifecycle.adopted !== true
            ) {
                return fail(
                    'plugin_managed_service_not_reusable',
                    'Unadopted managed Provider custody is retiring',
                );
            }
            if (existing) {
                if (stableJson(existing.scope) !== exactScopeKey) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'A new Provider claim cannot join an adopted managed service',
                    );
                }
                if (existing.disposal.started) {
                    return fail(
                        'plugin_managed_service_not_reusable',
                        'Disposing runner managed-service custody is not reusable',
                    );
                }
                const existingSnapshot = existing.handle.snapshot();
                if (
                    existingSnapshot.state === 'stopping'
                    || existingSnapshot.state === 'stopped'
                    || existingSnapshot.state === 'failed'
                ) {
                    return fail(
                        'plugin_managed_service_not_reusable',
                        'Terminal runner managed-service custody is not reusable',
                    );
                }
                const inFlightReuse = establishments.get(key);
                if (inFlightReuse) {
                    if (
                        stableJson(inFlightReuse.scope) !== exactScopeKey
                    ) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'A new Provider claim cannot join an establishing managed service',
                        );
                    }
                    if (
                        stableJson(inFlightReuse.spec)
                            !== stableJson(spec)
                    ) {
                        return fail(
                            'plugin_managed_service_spec_conflict',
                            'The establishing managed service specification conflicts with runner custody',
                        );
                    }
                    if (inFlightReuse.abandoned) {
                        return fail(
                            'plugin_managed_service_not_reusable',
                            'Abandoned runner managed-service establishment is not reusable',
                        );
                    }
                    await waitForCustodyEstablishment(
                        inFlightReuse,
                        options?.signal,
                    );
                    return await dispatch(request, options);
                }
                const created: CustodyEstablishment = {
                    scope,
                    spec,
                    promise: Promise.resolve(null as never),
                    controller: new AbortController(),
                    revisionAtAdmission: null,
                    waiters: 0,
                    settled: false,
                    abandoned: false,
                    cleanupFailureRetained: false,
                };
                const ownedEstablishment = created;
                created.promise = (async (): Promise<CustodyEntry> => {
                    await requireEntryExposable(existing);
                    const admission =
                        await input.resolveAuthorizedServicesForSupervise(
                            scope,
                        );
                    if (!admission) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services owner is unavailable',
                        );
                    }
                    const admissionRevision =
                        requireHardRevocationRevision(
                            admission
                                .providerPluginHardRevocationRevisionAtAdmission,
                        );
                    ownedEstablishment.revisionAtAdmission =
                        admissionRevision;
                    if (
                        admissionRevision !== existing
                            .providerPluginHardRevocationRevisionAtAdmission
                    ) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services owner is unavailable',
                        );
                    }
                    // SVC09 is the one canonical spec-equality/reuse owner.
                    // Custody registers only the in-flight acquisition and
                    // retains every returned wrapper on the existing entry.
                    const reusedHandle =
                        await admission.services.supervise(spec, {
                            signal: ownedEstablishment.controller.signal,
                        });
                    let retainedHandle: boolean;
                    try {
                        retainedHandle = await retainEntryHandle(
                            key,
                            existing,
                            reusedHandle,
                        );
                    } catch (error) {
                        ownedEstablishment.cleanupFailureRetained = true;
                        throw error;
                    }
                    if (!retainedHandle) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services custody ended during reuse',
                        );
                    }
                    await requireEntryExposable(existing);
                    if (
                        entries.get(key) !== existing
                        || existing.disposal.started
                        || ownedEstablishment.abandoned
                    ) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services custody ended during reuse',
                        );
                    }
                    requireCustodyActive();
                    return existing;
                })().finally(() => {
                    ownedEstablishment.settled = true;
                    if (establishments.get(key) === ownedEstablishment) {
                        establishments.delete(key);
                    }
                });
                establishments.set(key, created);
                await waitForCustodyEstablishment(
                    created,
                    options?.signal,
                );
                return Object.freeze({
                    v: 1,
                    kind: 'handle',
                    custodyScope: normalizeScope(existing.scope),
                    snapshot: cloneSnapshot(existing.handle.snapshot()),
                });
            }
            const inFlight = establishments.get(key);
            if (
                inFlight
                && stableJson(inFlight.scope) !== exactScopeKey
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'A new Provider claim cannot join an establishing managed service',
                );
            }
            if (
                inFlight
                && stableJson(inFlight.spec) !== stableJson(spec)
            ) {
                return fail(
                    'plugin_managed_service_spec_conflict',
                    'The establishing managed service specification conflicts with runner custody',
                );
            }
            if (inFlight?.abandoned) {
                return fail(
                    'plugin_managed_service_not_reusable',
                    'Abandoned runner managed-service establishment is not reusable',
                );
            }
            let establishment: CustodyEstablishment;
            if (inFlight) {
                establishment = inFlight;
            } else {
                const created: CustodyEstablishment = {
                    scope,
                    spec,
                    promise: Promise.resolve(null as never),
                    controller: new AbortController(),
                    revisionAtAdmission: null,
                    waiters: 0,
                    settled: false,
                    abandoned: false,
                    cleanupFailureRetained: false,
                };
                const ownedEstablishment = created;
                created.promise = (async (): Promise<CustodyEntry> => {
                    const admission =
                        await input.resolveAuthorizedServicesForSupervise(
                            scope,
                        );
                    if (!admission) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services owner is unavailable',
                        );
                    }
                    const admissionRevision =
                        requireHardRevocationRevision(
                            admission
                                .providerPluginHardRevocationRevisionAtAdmission,
                        );
                    ownedEstablishment.revisionAtAdmission =
                        admissionRevision;
                    await requireAuthorityCurrent(
                        scope,
                        admissionRevision,
                    );
                    const handle = await admission.services.supervise(
                        spec,
                        { signal: ownedEstablishment.controller.signal },
                    );
                    const entry = Object.freeze({
                        scope,
                        providerPluginHardRevocationRevisionAtAdmission:
                            admissionRevision,
                        handle,
                        disposal: {
                            handles: [handle],
                            activeRequests: new Set<AbortController>(),
                            started: false,
                            projectionCleanupComplete: false,
                            promise: null,
                            failure: null,
                        },
                        lifecycle: {
                            adopted: false,
                            authorityRetained: false,
                            projection: null,
                        },
                    });
                    entries.set(key, entry);
                    if (closed || ownedEstablishment.abandoned) {
                        try {
                            await disposeEntry(entry);
                        } catch (error) {
                            ownedEstablishment.cleanupFailureRetained = true;
                            throw error;
                        }
                        if (entries.get(key) === entry) {
                            entries.delete(key);
                        }
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Runner managed-services custody ended during establishment',
                        );
                    }
                    try {
                        await requireEntryExposable(entry);
                    } catch (error) {
                        try {
                            await disposeEntry(entry);
                            if (entries.get(key) === entry) {
                                entries.delete(key);
                            }
                        } catch (cleanupError) {
                            ownedEstablishment.cleanupFailureRetained = true;
                            throw new AggregateError(
                                [
                                    error,
                                    ...runnerManagedServiceCleanupAggregate(
                                        [cleanupError],
                                        'Managed Provider handle cleanup failed',
                                    ).errors,
                                ],
                                'Managed Provider authority and handle cleanup failed',
                            );
                        }
                        throw error;
                    }
                    return entry;
                })().finally(() => {
                    ownedEstablishment.settled = true;
                    if (establishments.get(key) === ownedEstablishment) {
                        establishments.delete(key);
                    }
                });
                establishments.set(key, created);
                establishment = created;
            }
            const entry = await waitForCustodyEstablishment(
                establishment,
                options?.signal,
            );
            await requireEntryExposable(entry);
            requireCustodyActive();
            return Object.freeze({
                v: 1,
                kind: 'handle',
                custodyScope: normalizeScope(entry.scope),
                snapshot: cloneSnapshot(entry.handle.snapshot()),
            });
        }
        const claim = normalizeClaim(request.claim);
        if (request.kind === 'readAdoptedPublicOutcome') {
            const retention = await readCurrentManagedProviderRetention();
            const outcome = retention
                && isExactRunnerManagedProviderCustodyScope(
                    retention.scope,
                    claim,
                )
                ? await readAdoptedPublicOutcome()
                : null;
            return Object.freeze({
                v: 1,
                kind: 'adoptedPublicOutcome',
                outcome,
            });
        }
        if (serviceId === null) {
            return fail(
                'plugin_managed_service_spec_invalid',
                'Managed service id is unavailable',
            );
        }
        const key = entryKey(claim, serviceId);
        if (request.kind === 'observe.close') {
            const observation = observations.get(request.observationId);
            const closedObservation = observation?.entryKey === key
                ? closeObservation(observation)
                : false;
            return Object.freeze({
                v: 1,
                kind: 'observe.close',
                closed: closedObservation,
            });
        }
        const entry = requireEntry(claim, serviceId);
        if (request.kind === 'projectEndpointAccess') {
            await requireEntryExposable(entry);
            requireCustodyActive();
            const endpointTemplateIds = request.endpoints.map(
                (endpoint) => endpoint.endpointTemplateId,
            );
            if (
                new Set(endpointTemplateIds).size
                    !== endpointTemplateIds.length
            ) {
                return fail(
                    'plugin_managed_service_spec_invalid',
                    'Managed Provider endpoint template ids must be unique',
                );
            }
            const existingProjection = entry.lifecycle.projection;
            if (existingProjection) {
                if (
                    stableJson(existingProjection.endpoints)
                        !== stableJson(request.endpoints)
                    || !existingProjection.owner.isCurrent()
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider endpoint projection is unavailable',
                    );
                }
                return Object.freeze({
                    v: 1,
                    kind: 'projected',
                });
            }
            if (!input.projectEndpointAccess) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Runner managed Provider endpoint projection is unavailable',
                );
            }
            const projected = await input.projectEndpointAccess({
                scope: entry.scope,
                service: entry.handle,
                endpoints: Object.freeze(request.endpoints.map(
                    (endpoint) => Object.freeze({ ...endpoint }),
                )),
                ...(options?.signal
                    ? { signal: options.signal }
                    : {}),
                isCurrent: () => (
                    !closed
                    && entries.get(key) === entry
                    && !entry.disposal.started
                ),
            });
            if (!projected) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Runner managed Provider endpoint projection failed',
                );
            }
            try {
                await requireEntryExposable(entry);
                requireCustodyActive();
                if (
                    entries.get(key) !== entry
                    || entry.disposal.started
                    || !projected.isCurrent()
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider custody changed during endpoint projection',
                    );
                }
                entry.lifecycle.projection = Object.freeze({
                    endpoints: Object.freeze(request.endpoints.map(
                        (endpoint) => Object.freeze({ ...endpoint }),
                    )),
                    owner: projected,
                });
            } catch (error) {
                await Promise.resolve(projected.cleanup())
                    .catch(() => undefined);
                throw error;
            }
            return Object.freeze({ v: 1, kind: 'projected' });
        }
        if (request.kind === 'adopt') {
            await requireEntryExposable(entry);
            requireCustodyActive();
            if (
                entries.get(key) !== entry
                || entry.disposal.started
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed Provider custody ended during adoption',
                );
            }
            return Object.freeze({
                v: 1,
                kind: 'handle',
                custodyScope: normalizeScope(entry.scope),
                snapshot: cloneSnapshot(entry.handle.snapshot()),
            });
        }
        if (request.kind === 'commitAdoption') {
            return await withAdoptionCommitFence(async () => {
                await requireEntryExposable(entry);
                requireCustodyActive();
                const projection = entry.lifecycle.projection;
                if (
                    entries.get(key) !== entry
                    || entry.disposal.started
                    || !projection
                    || !projection.owner.isCurrent()
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider public outcome is not ready for adoption',
                    );
                }
                const competingAdoption = [...entries.values()].some(
                    (candidate) => (
                        candidate !== entry
                        && !candidate.disposal.started
                        && (
                            candidate.lifecycle.adopted
                            || candidate.lifecycle.authorityRetained
                        )
                    ),
                );
                if (competingAdoption) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Runner already owns another managed Provider adoption',
                    );
                }
                if (!entry.lifecycle.authorityRetained) {
                    if (
                        !input.retainAdoptedProviderAuthority
                        || !await input.retainAdoptedProviderAuthority(
                            retainedAuthority(entry),
                        )
                    ) {
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Managed Provider immutable generation could not be retained',
                        );
                    }
                    entry.lifecycle.authorityRetained = true;
                }
                try {
                    await requireEntryExposable(entry);
                } catch (error) {
                    if (
                        entry.lifecycle.authorityRetained
                        && input.releaseAdoptedProviderAuthority
                        && await input.releaseAdoptedProviderAuthority(
                            retainedAuthority(entry),
                        )
                    ) {
                        entry.lifecycle.authorityRetained = false;
                    }
                    throw error;
                }
                if (
                    entries.get(key) !== entry
                    || entry.disposal.started
                    || !projection.owner.isCurrent()
                ) {
                    if (
                        entry.lifecycle.authorityRetained
                        && input.releaseAdoptedProviderAuthority
                        && await input.releaseAdoptedProviderAuthority(
                            retainedAuthority(entry),
                        )
                    ) {
                        entry.lifecycle.authorityRetained = false;
                    }
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider custody changed while committing adoption',
                    );
                }
                entry.lifecycle.adopted = true;
                return Object.freeze({ v: 1, kind: 'adopted' });
            });
        }
        if (request.kind === 'waitUntilHealthy') {
            await requireEntryExposable(entry);
            const snapshot = await entry.handle.waitUntilHealthy({
                ...(request.timeoutMs !== undefined
                    ? { timeoutMs: request.timeoutMs }
                    : {}),
                ...(options?.signal
                    ? { signal: options.signal }
                    : {}),
            });
            await requireEntryExposable(entry);
            requireCustodyActive();
            return Object.freeze({
                v: 1,
                kind: 'handle',
                custodyScope: normalizeScope(entry.scope),
                snapshot: cloneSnapshot(snapshot),
            });
        }
        if (request.kind === 'observe.open') {
            await requireEntryExposable(entry);
            requireCustodyActive();
            requireOperationActive(options?.signal);
            const observationId = randomUUID();
            let openingSnapshot: ManagedServiceSnapshot | null = null;
            let observation: CustodyObservation | null = null;
            const subscription = entry.handle.observe((snapshot) => {
                const next = cloneSnapshot(snapshot);
                if (!observation) {
                    openingSnapshot = next;
                    return;
                }
                // Managed-service snapshots are complete authoritative
                // projections. Coalescing to the newest pending projection
                // gives bounded backpressure without inventing event history.
                observation.queuedSnapshot = next;
                observation.wakePendingNext?.();
            });
            observation = {
                id: observationId,
                entryKey: key,
                subscription,
                queuedSnapshot: null,
                wakePendingNext: null,
                closed: false,
            };
            observations.set(observationId, observation);
            try {
                await requireEntryExposable(entry);
                requireCustodyActive();
                requireOperationActive(options?.signal);
            } catch (error) {
                closeObservation(observation);
                throw error;
            }
            return Object.freeze({
                v: 1,
                kind: 'observe.open',
                observationId,
                snapshot: cloneSnapshot(
                    openingSnapshot ?? entry.handle.snapshot(),
                ),
            });
        }
        if (request.kind === 'observe.next') {
            const observation = requireObservation(
                request.observationId,
                key,
            );
            try {
                await requireEntryExposable(entry);
                requireCustodyActive();
            } catch (error) {
                closeObservation(observation);
                throw error;
            }
            if (!observation.queuedSnapshot) {
                if (observation.wakePendingNext) {
                    return fail(
                        'plugin_managed_service_capacity_exceeded',
                        'Managed Provider custody observation already has a pending read',
                    );
                }
                if (options?.signal?.aborted) {
                    return fail(
                        'plugin_operation_aborted',
                        'Managed service observation was aborted',
                    );
                }
                await new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const finish = (
                        settle: () => void,
                    ) => {
                        if (settled) return;
                        settled = true;
                        options?.signal?.removeEventListener(
                            'abort',
                            onAbort,
                        );
                        if (observation.wakePendingNext === onWake) {
                            observation.wakePendingNext = null;
                        }
                        settle();
                    };
                    const onWake = () => finish(resolve);
                    const onAbort = () => finish(() => reject(
                        new PluginError({
                            code: 'plugin_operation_aborted',
                            message:
                                'Managed service observation was aborted',
                        }),
                    ));
                    observation.wakePendingNext = onWake;
                    options?.signal?.addEventListener(
                        'abort',
                        onAbort,
                        { once: true },
                    );
                    if (options?.signal?.aborted) onAbort();
                });
            }
            if (observation.closed) {
                return Object.freeze({
                    v: 1,
                    kind: 'observe.next',
                    status: 'closed',
                });
            }
            try {
                await requireEntryExposable(entry);
                requireCustodyActive();
            } catch (error) {
                closeObservation(observation);
                throw error;
            }
            const snapshot = observation.queuedSnapshot;
            observation.queuedSnapshot = null;
            if (!snapshot) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed Provider custody observation has no snapshot',
                );
            }
            return Object.freeze({
                v: 1,
                kind: 'observe.next',
                status: 'snapshot',
                snapshot: cloneSnapshot(snapshot),
            });
        }
        if (request.kind === 'stop') {
            abortEntryRequests(
                entry,
                'Exact managed-service handle is stopping',
            );
            const result = await entry.handle.stop({
                ...(options?.signal
                    ? { signal: options.signal }
                    : {}),
            });
            await requireEntryExposable(entry);
            requireCustodyActive();
            return Object.freeze({
                v: 1,
                kind: 'stop',
                result,
                snapshot: cloneSnapshot(entry.handle.snapshot()),
            });
        }
        if (entry.lifecycle.adopted) {
            try {
                await requireEntryExposable(entry);
                requireCustodyActive();
                if (
                    entries.get(key) === entry
                    && !entry.disposal.started
                ) {
                    // The remote daemon handle is only an observation/control
                    // proxy after explicit adoption. Session-local runner
                    // custody remains the lifecycle owner until Session end
                    // or a hard revocation fences the exact Provider.
                    return Object.freeze({ v: 1, kind: 'disposed' });
                }
            } catch {
                // Hard-revoked or unverifiable adopted custody fails closed
                // into the same authoritative cleanup below.
            }
        }
        const sameKeyEstablishment = establishments.get(key);
        if (sameKeyEstablishment) {
            sameKeyEstablishment.abandoned = true;
            sameKeyEstablishment.controller.abort(
                'Exact managed-service custody disposed during establishment',
            );
        }
        closeObservationsForEntry(key);
        const entryDisposalOutcome = disposeEntry(entry).then(
            () => Object.freeze({ status: 'fulfilled' as const }),
            (reason: unknown) => Object.freeze({
                status: 'rejected' as const,
                reason,
            }),
        );
        const establishmentFailures = sameKeyEstablishment
            ? await settleAbandonedEstablishments([
                [key, sameKeyEstablishment],
            ]).then((cleanup) => cleanup.failures)
            : [];
        const entryOutcome = await entryDisposalOutcome;
        const cleanupOutcomes = [entryOutcome];
        if (
            establishmentFailures.length === 0
            && entryOutcome.status === 'fulfilled'
            && entries.get(key) === entry
            && entry.disposal.handles.length > 0
        ) {
            cleanupOutcomes.push(await disposeEntry(entry).then(
                () => Object.freeze({ status: 'fulfilled' as const }),
                (reason: unknown) => Object.freeze({
                    status: 'rejected' as const,
                    reason,
                }),
            ));
        }
        const failures = [...establishmentFailures];
        if (failures.length === 0) {
            failures.push(...cleanupOutcomes.flatMap((outcome) =>
                outcome.status === 'rejected'
                    ? [outcome.reason]
                    : []));
        }
        if (failures.length > 0) {
            throw runnerManagedServiceCleanupAggregate(
                failures,
                'Failed to dispose exact managed-service custody',
            );
        }
        if (entries.get(key) === entry) entries.delete(key);
        return Object.freeze({ v: 1, kind: 'disposed' });
    };

    const exactHandleRequestPort:
        RunnerManagedServicesExactHandleRequestPortV1 = Object.freeze({
            async request(requestInput) {
                requireCustodyActive();
                const claim = normalizeClaim(requestInput.claim);
                const serviceId = ManagedServiceLocalIdSchema
                    .safeParse(requestInput.serviceId);
                if (!serviceId.success) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Exact adopted managed Provider service is unavailable',
                    );
                }
                const key = entryKey(claim, serviceId.data);
                const entry = requireEntry(claim, serviceId.data);
                await requireEntryExposable(entry);
                requireCustodyActive();
                if (
                    entries.get(key) !== entry
                    || entry.disposal.started
                ) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Exact adopted managed Provider service is unavailable',
                    );
                }
                const controller = new AbortController();
                const callerSignal = requestInput.request.signal;
                const onCallerAbort = (): void => {
                    controller.abort(callerSignal?.reason);
                };
                callerSignal?.addEventListener(
                    'abort',
                    onCallerAbort,
                    { once: true },
                );
                entry.disposal.activeRequests.add(controller);
                const release = (): void => {
                    callerSignal?.removeEventListener(
                        'abort',
                        onCallerAbort,
                    );
                    entry.disposal.activeRequests.delete(controller);
                };
                if (callerSignal?.aborted) onCallerAbort();
                try {
                    if (controller.signal.aborted) {
                        return fail(
                            'plugin_operation_aborted',
                            'Managed service request was aborted',
                        );
                    }
                    const response = await entry.handle.request({
                        ...requestInput.request,
                        signal: controller.signal,
                    });
                    await requireEntryExposable(entry);
                    requireCustodyActive();
                    if (
                        entries.get(key) !== entry
                        || entry.disposal.started
                        || controller.signal.aborted
                    ) {
                        controller.abort(
                            'Exact managed-service custody changed during request',
                        );
                        await response.body?.cancel().catch(() => undefined);
                        return fail(
                            'plugin_managed_service_unavailable',
                            'Exact adopted managed Provider service is unavailable',
                        );
                    }
                    if (!response.body) {
                        release();
                        return response;
                    }
                    const reader = response.body.getReader();
                    let settled = false;
                    const settle = (): void => {
                        if (settled) return;
                        settled = true;
                        controller.signal.removeEventListener(
                            'abort',
                            onCustodyAbort,
                        );
                        try {
                            reader.releaseLock();
                        } catch {
                            // A pending read retains the lock until it settles.
                        }
                        release();
                    };
                    const onCustodyAbort = (): void => {
                        void reader.cancel(controller.signal.reason)
                            .catch(() => undefined)
                            .finally(settle);
                    };
                    controller.signal.addEventListener(
                        'abort',
                        onCustodyAbort,
                        { once: true },
                    );
                    if (controller.signal.aborted) onCustodyAbort();
                    return Object.freeze({
                        ...response,
                        body: new ReadableStream<Uint8Array>({
                            async pull(streamController) {
                                try {
                                    const next = await reader.read();
                                    if (next.done) {
                                        settle();
                                        streamController.close();
                                        return;
                                    }
                                    streamController.enqueue(next.value);
                                } catch (error) {
                                    settle();
                                    streamController.error(error);
                                }
                            },
                            async cancel(reason) {
                                controller.abort(reason);
                                try {
                                    await reader.cancel(reason);
                                } finally {
                                    settle();
                                }
                            },
                        }),
                    });
                } catch (error) {
                    release();
                    throw error;
                }
            },
            async isCurrent(currentInput) {
                try {
                    requireCustodyActive();
                    const claim = normalizeClaim(currentInput.claim);
                    const serviceId = ManagedServiceLocalIdSchema
                        .safeParse(currentInput.serviceId);
                    if (!serviceId.success) return false;
                    const entry = entries.get(entryKey(
                        claim,
                        serviceId.data,
                    ));
                    if (!entry || entry.disposal.started) return false;
                    await requireEntryExposable(entry);
                    return !closed
                        && entries.get(entryKey(claim, serviceId.data))
                            === entry
                        && !entry.disposal.started;
                } catch {
                    return false;
                }
            },
        });

    const readCurrentManagedProviderRetention = async ():
        Promise<RunnerDaemonManagedProviderRetentionV1 | null> => {
        requireCustodyActive();
        activeManagedProviderRetentionReads += 1;
        try {
            const retiringEstablishments = [...establishments.entries()]
                .filter(([key]) => (
                    entries.get(key)?.lifecycle.adopted !== true
                ));
            for (const [, establishment] of retiringEstablishments) {
                establishment.abandoned = true;
                establishment.controller.abort(
                    'Unadopted managed Provider establishment retired',
                );
            }
            const establishmentCleanup =
                await settleAbandonedEstablishments(
                    retiringEstablishments,
                );
            const unadopted = [...entries.entries()].filter(
                ([key, entry]) => (
                    !entry.disposal.started
                    && !entry.lifecycle.adopted
                    && !establishmentCleanup.retainedEntryKeys.has(key)
                ),
            );
            const entryOutcomes = await Promise.allSettled(
                unadopted.map(async ([key, entry]) => {
                    closeObservationsForEntry(key);
                    await disposeEntry(entry);
                    if (entries.get(key) === entry) entries.delete(key);
                }),
            );
            const retirementFailures = [
                ...establishmentCleanup.failures,
                ...entryOutcomes.flatMap((outcome) =>
                    outcome.status === 'rejected'
                        ? [outcome.reason]
                        : []),
            ];
            if (retirementFailures.length > 0) {
                throw runnerManagedServiceCleanupAggregate(
                    retirementFailures,
                    'Failed to retire unadopted runner managed services',
                );
            }
            const retained = new Map<string, CustodyEntry>();
            for (const entry of entries.values()) {
                if (
                    entry.disposal.started
                    || !entry.lifecycle.adopted
                    || !entry.lifecycle.projection
                    || !entry.lifecycle.projection.owner.isCurrent()
                ) continue;
                retained.set(claimKey(claimFromScope(entry.scope)), entry);
            }
            if (retained.size === 0) return null;
            if (retained.size !== 1) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Runner has multiple managed Provider custody scopes',
                );
            }
            const entry = retained.values().next().value!;
            await requireEntryExposable(entry);
            requireCustodyActive();
            if (
                entry.disposal.started
                || ![...entries.values()].includes(entry)
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Runner managed Provider retention ended during read',
                );
            }
            return Object.freeze({
                v: 1,
                scope: normalizeScope(entry.scope),
                providerPluginHardRevocationRevisionAtAdmission:
                    entry.providerPluginHardRevocationRevisionAtAdmission,
            });
        } finally {
            activeManagedProviderRetentionReads -= 1;
        }
    };

    const readAdoptedPublicOutcome = async ():
        Promise<RunnerManagedProviderAdoptedPublicOutcomeV1 | null> => {
        const retention = await readCurrentManagedProviderRetention();
        if (!retention) return null;
        const retainedEntries = [...entries.values()].filter((entry) => (
            entry.lifecycle.adopted
            && !entry.disposal.started
            && isExactRunnerManagedProviderCustodyScope(
                entry.scope,
                retention.scope,
            )
        ));
        if (retainedEntries.length !== 1) {
            return fail(
                'plugin_managed_service_unavailable',
                'Runner adopted managed Provider outcome is ambiguous',
            );
        }
        const entry = retainedEntries[0]!;
        const projection = entry.lifecycle.projection;
        if (!projection || !projection.owner.isCurrent()) return null;
        const endpointUrls = projection.endpoints.map(
            (endpoint) => projection.owner.access.endpointUrl(
                endpoint.endpointTemplateId,
            ),
        );
        if (endpointUrls.some((entry) => entry === null)) {
            return null;
        }
        return Object.freeze({
            operationClaimId: entry.scope.operationClaimId,
            serviceId: entry.handle.snapshot().id,
            endpointTemplateIds: Object.freeze(
                projection.endpoints.map(
                    (endpoint) => endpoint.endpointTemplateId,
                ),
            ),
            endpoints: Object.freeze(projection.endpoints.map(
                (endpoint, index) => Object.freeze({
                    ...endpoint,
                    endpointUrl: endpointUrls[index]!,
                }),
            )),
            endpointAccess: 'runnerProjected' as const,
        });
    };

    let agentBindingMaterializationAttempted = false;
    const materializeAdoptedProviderAgentBinding = async (
        materializeInput: Readonly<{
            materialize(input: Readonly<{
                endpointUrl: string;
                credentialPlaceholder: string;
            }>): Promise<unknown>;
        }>,
    ): Promise<RunnerManagedProviderAgentBindingMaterializationV1> => {
        if (agentBindingMaterializationAttempted) {
            return fail(
                'plugin_managed_service_unavailable',
                'Managed Provider Agent materialization was already attempted',
            );
        }
        agentBindingMaterializationAttempted = true;
        const retention = await readCurrentManagedProviderRetention();
        const entry = retention
            ? [...entries.values()].find((candidate) => (
                candidate.lifecycle.adopted
                && !candidate.disposal.started
                && isExactRunnerManagedProviderCustodyScope(
                    candidate.scope,
                    retention.scope,
                )
            )) ?? null
            : null;
        const projection = entry?.lifecycle.projection ?? null;
        if (
            !entry
            || !projection
            || !projection.owner.isCurrent()
            || !input.materializeAgentBinding
        ) {
            return fail(
                'plugin_managed_service_unavailable',
                'Exact adopted managed Provider Agent materialization is unavailable',
            );
        }
        try {
            const materialized = await input.materializeAgentBinding({
                scope: entry.scope,
                service: entry.handle,
                projection: projection.owner,
                endpointTemplateId:
                    entry.scope.runtimeBindingBasis
                        .endpoint.endpointTemplateId,
                materialize: materializeInput.materialize,
            });
            if (
                !materialized
                || entries.get(entryKey(
                    claimFromScope(entry.scope),
                    entry.handle.snapshot().id,
                )) !== entry
                || !projection.owner.isCurrent()
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed Provider authority changed during Agent materialization',
                );
            }
            return materialized;
        } catch (error) {
            const key = entryKey(
                claimFromScope(entry.scope),
                entry.handle.snapshot().id,
            );
            closeObservationsForEntry(key);
            const cleanupSucceeded = await disposeEntry(entry)
                .then(() => true, () => false);
            if (cleanupSucceeded && entries.get(key) === entry) {
                entries.delete(key);
            }
            throw error;
        }
    };

    const dispose = async (): Promise<void> => {
        if (cleanupPromise) {
            await cleanupPromise;
            return;
        }
        closed = true;
        const attempt = (async () => {
            const ownedEstablishments = [...establishments.entries()];
            for (const [, establishment] of ownedEstablishments) {
                establishment.abandoned = true;
                establishment.controller.abort();
            }
            const establishmentCleanup =
                await settleAbandonedEstablishments(
                    ownedEstablishments,
                );
            for (const observation of [...observations.values()]) {
                closeObservation(observation);
            }
            const ownedEntries = [...entries.entries()].filter(
                ([key]) => !establishmentCleanup
                    .retainedEntryKeys.has(key),
            );
            const outcomes = await Promise.allSettled(
                ownedEntries.map(async ([key, entry]) => {
                    await disposeEntry(entry);
                    if (entries.get(key) === entry) entries.delete(key);
                }),
            );
            const failures = [
                ...establishmentCleanup.failures,
                ...outcomes.flatMap((outcome) =>
                    outcome.status === 'rejected'
                        ? [outcome.reason]
                        : []),
            ];
            if (failures.length > 0) {
                throw runnerManagedServiceCleanupAggregate(
                    failures,
                    'Failed to dispose runner managed-services custody',
                );
            }
        })();
        cleanupPromise = attempt;
        try {
            await attempt;
        } finally {
            if (cleanupPromise === attempt) cleanupPromise = null;
        }
    };

    return Object.freeze({
        dispatch,
        exactHandleRequestPort,
        readCurrentManagedProviderRetention,
        readAdoptedPublicOutcome,
        materializeAdoptedProviderAgentBinding,
        dispose,
    });
}

export function registerRunnerManagedServicesCustodyRpcHandler(
    rpc: RpcHandlerRegistrar,
    port: RunnerManagedServicesCustodyPortV1,
): void {
    rpc.registerHandler(
        RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
        async (raw, context) => await port.dispatch(
            RunnerManagedServicesCustodyRequestV1Schema.parse(raw),
            context?.signal ? { signal: context.signal } : undefined,
        ),
    );
}

function requireHandleResult(
    result: RunnerManagedServicesCustodyResultV1,
): Extract<RunnerManagedServicesCustodyResultV1, { kind: 'handle' }> {
    return result.kind === 'handle'
        ? result
        : fail(
            'plugin_managed_service_establishment_failed',
            'Runner returned the wrong managed-service result',
        );
}

export function createRunnerManagedServicesClient(input: Readonly<{
    dependencies: ManagedDependenciesService;
    dispatch: RunnerManagedServicesCustodyDispatchV1;
    endpointReadRpc?: Readonly<{
        call(input: Readonly<{
            method: string;
            request: unknown;
            timeoutMs: number;
            signal?: AbortSignal;
        }>): Promise<unknown>;
    }>;
}> & (
    | Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        claim?: never;
    }>
    | Readonly<{
        claim: RunnerManagedProviderCustodyClaimV1;
        scope?: never;
    }>
)): Readonly<{
    services: ManagedServices;
    adopt(serviceId: string): Promise<ManagedServiceHandle>;
    commitAdoption(serviceId: string): Promise<void>;
    projectEndpointAccess(input: Readonly<{
        service: ManagedServiceHandle;
        endpoints: readonly RunnerManagedProviderEndpointPathV1[];
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null>;
    readAdoptedPublicOutcome():
        Promise<RunnerManagedProviderAdoptedPublicOutcomeV1 | null>;
    fenceRetainedProviderPolicy(): Promise<void>;
}> {
    const scope = input.scope
        ? normalizeScope(input.scope)
        : null;
    const claim = scope
        ? claimFromScope(scope)
        : normalizeClaim(input.claim!);

    const createHandle = async (
        initial: ManagedServiceSnapshot,
    ): Promise<ManagedServiceHandle> => {
        let current = cloneSnapshot(initial);
        const listeners = new Set<
            (snapshot: ManagedServiceSnapshot) => void
        >();
        let disposePromise: Promise<void> | null = null;
        const publish = (next: ManagedServiceSnapshot) => {
            current = cloneSnapshot(next);
            for (const listener of listeners) {
                try {
                    listener(current);
                } catch {
                    // A daemon observer cannot alter runner custody.
                }
            }
            return current;
        };
        type ClientObservation = {
            controller: AbortController;
            observationId: string | null;
            task: Promise<void>;
        };
        let observation: ClientObservation | null = null;
        let disposed = false;
        const activeEndpointRequests = new Map<
            string,
            () => Promise<void>
        >();
        const startObservation = (): void => {
            if (disposed || listeners.size === 0 || observation) return;
            const owned: ClientObservation = {
                controller: new AbortController(),
                observationId: null,
                task: Promise.resolve(),
            };
            observation = owned;
            owned.task = (async () => {
                try {
                    const opened = await input.dispatch({
                        v: 1,
                        kind: 'observe.open',
                        claim,
                        serviceId: current.id,
                    }, { signal: owned.controller.signal });
                    if (opened.kind !== 'observe.open') return;
                    owned.observationId = opened.observationId;
                    if (
                        owned.controller.signal.aborted
                        || listeners.size === 0
                    ) return;
                    if (stableJson(opened.snapshot) !== stableJson(current)) {
                        publish(opened.snapshot);
                    }
                    while (!owned.controller.signal.aborted) {
                        const next = await input.dispatch({
                            v: 1,
                            kind: 'observe.next',
                            claim,
                            serviceId: current.id,
                            observationId: opened.observationId,
                        }, { signal: owned.controller.signal });
                        if (
                            next.kind !== 'observe.next'
                            || next.status === 'closed'
                        ) return;
                        publish(next.snapshot);
                    }
                } catch {
                    // Observation is advisory to the local handle. Every
                    // authoritative operation still fails typed at dispatch.
                } finally {
                    if (owned.observationId) {
                        await input.dispatch({
                            v: 1,
                            kind: 'observe.close',
                            claim,
                            serviceId: current.id,
                            observationId: owned.observationId,
                        }).catch(() => undefined);
                    }
                    if (observation === owned) observation = null;
                }
            })();
        };
        const stopObservation = async (): Promise<void> => {
            const owned = observation;
            if (!owned) return;
            owned.controller.abort();
            await owned.task;
        };
        const cancelEndpointRequests = async (): Promise<void> => {
            await Promise.allSettled(
                [...activeEndpointRequests.values()].map(
                    async (cancel) => await cancel(),
                ),
            );
        };
        const requestExactHandle = async (
            request: ManagedServiceRequest,
        ): Promise<ManagedServiceResponse> => {
            if (disposed || !input.endpointReadRpc) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Runner managed-service request transport is unavailable',
                );
            }
            const rpc = input.endpointReadRpc;
            const requestId = randomUUID();
            const rpcTimeoutMs = Math.min(
                (request.timeoutMs ?? 300_000) + 5_000,
                2_147_483_647,
            );
            const route = Object.freeze({
                kind: 'exactHandle' as const,
                claim,
                serviceId: current.id,
            });
            const parsedOpenRequest =
                ManagedServiceEndpointReadOpenRequestV1Schema.safeParse({
                    v: 1,
                    requestId,
                    route,
                    pathAndQuery: request.pathAndQuery,
                    headers: request.headers ?? {},
                    ...(request.method !== undefined
                        ? { method: request.method }
                        : {}),
                    ...(request.body !== undefined
                        ? {
                            bodyBase64: Buffer.from(request.body)
                                .toString('base64'),
                        }
                        : {}),
                    ...(request.timeoutMs !== undefined
                        ? { timeoutMs: request.timeoutMs }
                        : {}),
                });
            if (!parsedOpenRequest.success) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed service request is invalid',
                );
            }
            const openRequest:
                ManagedServiceEndpointReadOpenRequestV1 =
                parsedOpenRequest.data;
            let openDispatched = false;
            let settled = false;
            let cancelPromise: Promise<void> | null = null;
            const transportController = new AbortController();
            const release = (): void => {
                if (settled) return;
                settled = true;
                request.signal?.removeEventListener(
                    'abort',
                    onCallerAbort,
                );
                activeEndpointRequests.delete(requestId);
            };
            const cancelRemote = async (): Promise<void> => {
                transportController.abort(
                    'Managed service endpoint request was cancelled',
                );
                if (!openDispatched) {
                    release();
                    return;
                }
                cancelPromise ??= (async () => {
                    try {
                        const raw = await rpc.call({
                            method:
                                MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS
                                    .CANCEL,
                            timeoutMs: 5_000,
                            request: {
                                v: 1,
                                requestId,
                                route,
                            },
                        });
                        ManagedServiceEndpointReadCancelResultV1Schema
                            .parse(raw);
                    } catch {
                        // Runner retirement and custody fencing bound failed
                        // best-effort cancellation.
                    }
                })();
                try {
                    await cancelPromise;
                } finally {
                    release();
                }
            };
            const onCallerAbort = (): void => {
                void cancelRemote();
            };
            activeEndpointRequests.set(requestId, cancelRemote);
            request.signal?.addEventListener(
                'abort',
                onCallerAbort,
                { once: true },
            );
            if (request.signal?.aborted) {
                await cancelRemote();
                return fail(
                    'plugin_operation_aborted',
                    'Managed service request was aborted',
                );
            }
            try {
                openDispatched = true;
                const rawOpen = await rpc.call({
                    method: MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN,
                    timeoutMs: rpcTimeoutMs,
                    request: openRequest,
                    signal: transportController.signal,
                });
                const opened = ManagedServiceEndpointReadOpenResultV1Schema
                    .parse(rawOpen);
                if (
                    opened.status !== 'opened'
                    || disposed
                    || request.signal?.aborted
                ) {
                    await cancelRemote();
                    return fail(
                        request.signal?.aborted
                            ? 'plugin_operation_aborted'
                            : 'plugin_managed_service_unavailable',
                        request.signal?.aborted
                            ? 'Managed service request was aborted'
                            : 'Runner managed-service request is unavailable',
                    );
                }
                const headers = Object.fromEntries(
                    opened.response.headers,
                );
                if (!opened.response.hasBody) {
                    release();
                    return Object.freeze({
                        ok: opened.response.status >= 200
                            && opened.response.status <= 299,
                        status: opened.response.status,
                        statusText: opened.response.statusText,
                        headers: Object.freeze(headers),
                        body: null,
                    });
                }
                const body = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        try {
                            const rawNext = await rpc.call({
                                method:
                                    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS
                                        .NEXT,
                                timeoutMs:
                                    MANAGED_SERVICE_ENDPOINT_READ_NEXT_RPC_TIMEOUT_MS,
                                request: {
                                    v: 1,
                                    requestId,
                                    route,
                                },
                                signal: transportController.signal,
                            });
                            const next =
                                ManagedServiceEndpointReadNextResultV1Schema
                                    .parse(rawNext);
                            if (next.status === 'chunk') {
                                controller.enqueue(Buffer.from(
                                    next.dataBase64,
                                    'base64',
                                ));
                                return;
                            }
                            if (next.status === 'end') {
                                release();
                                controller.close();
                                return;
                            }
                            throw new PluginError({
                                code:
                                    'plugin_managed_service_unavailable',
                                message:
                                    'Runner managed-service response became unavailable',
                            });
                        } catch (error) {
                            await cancelRemote();
                            controller.error(error);
                        }
                    },
                    async cancel() {
                        await cancelRemote();
                    },
                });
                return Object.freeze({
                    ok: opened.response.status >= 200
                        && opened.response.status <= 299,
                    status: opened.response.status,
                    statusText: opened.response.statusText,
                    headers: Object.freeze(headers),
                    body,
                });
            } catch (error) {
                await cancelRemote();
                throw error;
            }
        };
        return Object.freeze({
            snapshot: () => current,
            observe(listener: (snapshot: ManagedServiceSnapshot) => void) {
                listeners.add(listener);
                try {
                    listener(current);
                } catch {
                    // A daemon observer cannot alter runner custody.
                }
                startObservation();
                return Object.freeze({
                    dispose() {
                        listeners.delete(listener);
                        if (listeners.size === 0) {
                            return stopObservation();
                        }
                        return undefined;
                    },
                });
            },
            async waitUntilHealthy(options?: Readonly<{
                timeoutMs?: number;
                signal?: AbortSignal;
            }>) {
                const result = requireHandleResult(await input.dispatch({
                    v: 1,
                    kind: 'waitUntilHealthy',
                    claim,
                    serviceId: current.id,
                    ...(options?.timeoutMs !== undefined
                        ? { timeoutMs: options.timeoutMs }
                        : {}),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined));
                return publish(result.snapshot);
            },
            request: requestExactHandle,
            async stop(options?: Readonly<{ signal?: AbortSignal }>) {
                await cancelEndpointRequests();
                const result = await input.dispatch({
                    v: 1,
                    kind: 'stop',
                    claim,
                    serviceId: current.id,
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
                if (result.kind !== 'stop') {
                    return fail(
                        'plugin_managed_service_establishment_failed',
                        'Runner returned the wrong managed-service stop result',
                    );
                }
                publish(result.snapshot);
                return result.result;
            },
            dispose() {
                if (disposePromise) return disposePromise;
                let complete = false;
                const attempt = (async () => {
                    disposed = true;
                    listeners.clear();
                    await stopObservation();
                    await cancelEndpointRequests();
                    const result = await input.dispatch({
                        v: 1,
                        kind: 'dispose',
                        claim,
                        serviceId: current.id,
                    });
                    if (result.kind !== 'disposed') {
                        return fail(
                            'plugin_managed_service_establishment_failed',
                            'Runner returned the wrong managed-service disposal result',
                        );
                    }
                    complete = true;
                })().finally(() => {
                    if (!complete && disposePromise === attempt) {
                        disposePromise = null;
                    }
                });
                disposePromise = attempt;
                return attempt;
            },
        });
    };

    const supervise: ManagedServices['supervise'] = async (
        spec: ManagedServiceSpec,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
        if (!scope) {
            return fail(
                'plugin_managed_service_unavailable',
                'Adopted managed Provider custody cannot create a new service',
            );
        }
        const result = requireHandleResult(await input.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec: encodeRunnerManagedServiceSpecWireV1(spec),
        }, options?.signal
            ? { signal: options.signal }
            : undefined));
        return await createHandle(result.snapshot);
    };
    const adopt = async (serviceId: string) => {
        const result = requireHandleResult(await input.dispatch({
            v: 1,
            kind: 'adopt',
            claim,
            serviceId,
        }));
        return await createHandle(result.snapshot);
    };
    const commitAdoption = async (serviceId: string): Promise<void> => {
        const result = await input.dispatch({
            v: 1,
            kind: 'commitAdoption',
            claim,
            serviceId,
        });
        if (result.kind !== 'adopted') {
            return fail(
                'plugin_managed_service_establishment_failed',
                'Runner returned the wrong managed Provider adoption result',
            );
        }
    };
    const projectEndpointAccess = async (projectionInput: Readonly<{
        service: ManagedServiceHandle;
        endpoints: readonly RunnerManagedProviderEndpointPathV1[];
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null> => {
        const result = await input.dispatch({
            v: 1,
            kind: 'projectEndpointAccess',
            claim,
            serviceId: projectionInput.service.snapshot().id,
            endpoints: projectionInput.endpoints,
        }, { signal: projectionInput.signal });
        if (result.kind !== 'projected') return null;
        let active = true;
        const endpointUrls = new Map<string, string>();
        const baseUrl = projectionInput.service.snapshot().baseUrl;
        if (!baseUrl) return null;
        try {
            for (const endpoint of projectionInput.endpoints) {
                endpointUrls.set(
                    endpoint.endpointTemplateId,
                    new URL(
                        endpoint.servicePath,
                        `${baseUrl.replace(/\/+$/u, '')}/`,
                    ).toString(),
                );
            }
        } catch {
            return null;
        }
        const isCurrent = (): boolean => (
            active
            && !projectionInput.signal.aborted
            && projectionInput.isCurrent()
        );
        return Object.freeze({
            access: Object.freeze({
                endpointUrl(endpointTemplateId: string): string | null {
                    return isCurrent()
                        ? endpointUrls.get(endpointTemplateId) ?? null
                        : null;
                },
                async request(): Promise<never> {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider endpoint requests remain runner-local',
                    );
                },
            }),
            isCurrent,
            cleanup() {
                active = false;
            },
        });
    };
    const readAdoptedPublicOutcome = async () => {
        const result = await input.dispatch({
            v: 1,
            kind: 'readAdoptedPublicOutcome',
            claim,
        });
        if (result.kind !== 'adoptedPublicOutcome') {
            return fail(
                'plugin_managed_service_establishment_failed',
                'Runner returned the wrong adopted Provider outcome result',
            );
        }
        return result.outcome;
    };

    const fenceRetainedProviderPolicy = async (): Promise<void> => {
        const result = await input.dispatch({
            v: 1,
            kind: 'fenceRetainedProviderPolicy',
            claim,
        });
        if (result.kind !== 'retainedProviderPolicyFenced') {
            fail(
                'plugin_managed_service_unavailable',
                'Runner returned the wrong retained Provider policy-fence result',
            );
        }
    };
    return Object.freeze({
        services: Object.freeze({
            dependencies: input.dependencies,
            supervise,
        }),
        adopt,
        commitAdoption,
        projectEndpointAccess,
        readAdoptedPublicOutcome,
        fenceRetainedProviderPolicy,
    });
}
